import { loadPrism, Notice, setIcon, setTooltip } from 'obsidian';
import { ansiText, renderAnsi } from './ansi';
import { decodeAnsiSource } from './ansi-text';
import { copyCode, createExpandFooter } from './render';
import type { CodeBlock } from './codeblock';
import type { CommandPrompt } from './commands';
import { COLOR_MODES, type MottoSettings, type OutputToggleIcon } from './settings';
import { ReadingCodeLayout, shouldShowLineNumbers } from './line-numbers';
import hippoIcon from './hippo.svg';
import { replyToHippo, updateHippoSpeech } from './hippo-speech';
import { createEl, createFragment } from './dom';

export function commandPrompt(
  document: Document, { symbol, inlineContext, tooltip }: CommandPrompt, toggleWrap?: () => void,
): HTMLElement {
  const prompt = createEl(document, toggleWrap ? 'button' : 'span');
  prompt.className = 'motto-command-prompt';
  if (inlineContext) {
    const context = prompt.createSpan();
    context.className = 'motto-command-prompt-context';
    context.textContent = inlineContext;
  }
  const marker = prompt.createSpan();
  marker.className = 'motto-command-prompt-symbol';
  marker.textContent = symbol;
  if (tooltip) {
    setTooltip(marker, tooltip, { placement: 'top', delay: 100, classes: ['motto-prompt-tooltip'], gap: 8 });
    prompt.setAttribute('aria-description', tooltip);
  }
  if (toggleWrap) {
    prompt.setAttribute('type', 'button');
    prompt.setAttribute('aria-label', 'Toggle command wrapping');
    prompt.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleWrap();
    });
  }
  return prompt;
}

function copyButton(document: Document, text: string, label: string): HTMLButtonElement {
  const button = createEl(document, 'button');
  button.className = 'motto-command-button';
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void copyCode(document, text);
  });
  return button;
}

export function commandCopyButton(document: Document, text: string, label: string): HTMLButtonElement {
  const button = copyButton(document, text, label);
  button.classList.add('motto-command-copy');
  setIcon(button, 'copy');
  return button;
}

export function terminalDeleteButton(document: Document, label: string, remove: () => void): HTMLButtonElement {
  const button = createEl(document, 'button');
  button.className = 'motto-command-button motto-terminal-delete';
  button.type = 'button';
  button.contentEditable = 'false';
  button.setAttribute('aria-label', label);
  setTooltip(button, label);
  setIcon(button, 'trash-2');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (button.isConnected) remove();
  });
  return button;
}

export function terminalEditButton(document: Document, label: string, edit: () => void): HTMLButtonElement {
  const button = createEl(document, 'button');
  button.className = 'motto-command-button';
  button.type = 'button';
  button.setAttribute('aria-label', label);
  setIcon(button, 'pencil');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    edit();
  });
  return button;
}

function rawOutputCopyButton(document: Document, text: string): HTMLButtonElement {
  const button = copyButton(document, text, 'Copy raw output (including ANSI escape sequences)');
  button.classList.add('motto-raw-copy');
  for (const letter of 'RAW') {
    const span = button.createSpan();
    span.textContent = letter;
    span.setAttribute('aria-hidden', 'true');
  }
  return button;
}

const OUTPUT_TOGGLE_GLYPHS: Record<Exclude<OutputToggleIcon, 'hippo'>, readonly [string, string]> = {
  eye: ['eye', 'eye-off'],
  monitor: ['monitor', 'monitor-off'],
  expand: ['chevrons-up-down', 'chevrons-down-up'],
  book: ['book-open', 'book'],
  chevron: ['chevron-down', 'chevron-up'],
};

export function setOutputToggle(
  button: HTMLButtonElement, open: boolean, styles: MottoSettings['outputToggleStyles'], tapMyHippo = false, partial = false,
): void {
  const closes = open && !partial;
  const label = partial ? 'Show full output' : closes ? 'Hide output' : 'Show output';
  const tools = button.parentElement;
  if (tools?.classList.contains('motto-command-tools')) {
    for (const mode of COLOR_MODES) {
      tools.classList.toggle(`motto-output-wide-${mode}`, styles[mode].icon === 'hippo');
    }
  }
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', label);
  button.replaceChildren();
  for (const mode of COLOR_MODES) {
    const style = styles[mode];
    const icon = button.createSpan();
    icon.className = `motto-output-icon motto-output-icon-${mode}`;
    icon.setAttribute('aria-hidden', 'true');
    const closing = closes !== style.reverseIcons;
    if (style.icon === 'hippo') {
      icon.classList.add('motto-output-icon-hippo');
      const mark = icon.createSpan();
      mark.className = 'motto-output-hippo';
      mark.classList.toggle('motto-output-hippo-flipped', !closing);
      mark.style.maskImage = `url(${JSON.stringify(hippoIcon)})`;
      mark.style.setProperty('-webkit-mask-image', mark.style.maskImage);
    } else {
      setIcon(icon, OUTPUT_TOGGLE_GLYPHS[style.icon][closing ? 1 : 0]);
    }
    const property = `--motto-output-${mode}-color`;
    if (style.overrideColor) button.style.setProperty(property, style.color);
    else button.style.removeProperty(property);
  }
  updateHippoSpeech(button, closes, styles, tapMyHippo);
}

export function commandTools(
  document: Document, text: string | null, open: boolean, styles: MottoSettings['outputToggleStyles'],
  toggle?: () => void, tapMyHippo = false, partial = false,
): HTMLElement {
  const tools = createEl(document, 'span');
  tools.className = 'motto-command-tools';
  if (toggle) {
    const button = tools.createEl('button');
    button.className = 'motto-command-button motto-output-toggle';
    button.type = 'button';
    setOutputToggle(button, open, styles, tapMyHippo, partial);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      replyToHippo(button);
      toggle();
    });
  }
  if (text !== null) {
    const copy = commandCopyButton(document, text, 'Copy command');
    copy.disabled = text === '';
    tools.append(copy);
  }
  return tools;
}

export function outputToggleClasses(styles: MottoSettings['outputToggleStyles']): string {
  return COLOR_MODES.filter((mode) => styles[mode].icon === 'hippo')
    .map((mode) => `motto-output-wide-${mode}`).join(' ');
}

function isPrismHighlighter(prism: unknown): prism is { highlightElement(element: HTMLElement): void } {
  return typeof prism === 'object' && prism !== null &&
    'highlightElement' in prism && typeof prism.highlightElement === 'function';
}

async function highlightOutput(code: HTMLElement): Promise<void> {
  try {
    const prism: unknown = await loadPrism();
    if (!isPrismHighlighter(prism)) {
      throw new Error('Prism highlighting is unavailable.');
    }
    prism.highlightElement(code);
  } catch (error) {
    console.error('[Motto Code Block] Failed to highlight output.', error);
    new Notice('Motto Code Block: Failed to highlight output.');
  }
}

export function commandOutput(
  document: Document, source: string, edit?: () => void, language = 'ansi', remove?: () => void, ansiRaw?: true,
): HTMLElement {
  const text = language === 'ansi' ? decodeAnsiSource(source, ansiRaw) : source;
  const output = createEl(document, 'div');
  output.className = 'motto-ansi-view motto-command-output';
  const tools = output.createDiv();
  tools.className = 'motto-output-tools';
  if (edit) {
    output.classList.add('motto-output-editable');
    tools.append(terminalEditButton(document, 'Edit source', edit));
  }
  if (remove) tools.append(terminalDeleteButton(document, 'Delete output only', remove));
  if (language === 'ansi') {
    output.classList.add('motto-output-has-raw');
    tools.append(rawOutputCopyButton(document, text));
  }
  tools.append(commandCopyButton(document, language === 'ansi' ? ansiText(text) : text, 'Copy output'));
  const pre = output.createEl('pre');
  const code = pre.createEl('code');
  if (language === 'ansi') code.append(renderAnsi(document, text));
  else {
    code.className = `language-${language || 'plaintext'}`;
    code.textContent = text;
    void highlightOutput(code);
  }
  return output;
}

export function commandOutputPreview(
  document: Document, block: CodeBlock, preview: number | undefined, expand: () => void, edit?: () => void,
  remove?: () => void,
): { element: HTMLElement; destroy: () => void } {
  const element = commandOutput(document, block.text, edit, block.language, remove, block.ansiRaw);
  const pre = element.querySelector<HTMLElement>('pre')!;
  const code = pre.querySelector<HTMLElement>('code')!;
  const layout = preview !== undefined ? new ReadingCodeLayout(pre, code, block.lineCount, false, preview) : null;
  if (preview !== undefined) {
    element.classList.add('motto-command-output-partial');
    element.append(createExpandFooter(document, block.lineCount - preview, expand));
  }
  return { element, destroy: () => { layout?.destroy(); } };
}

export function ansiPreview(
  document: Document, block: CodeBlock, settings: MottoSettings, preview: number | undefined, edit?: () => void,
): { element: HTMLElement; destroy: () => void } {
  const element = commandOutput(document, block.text, edit, 'ansi', undefined, block.ansiRaw);
  element.classList.replace('motto-command-output', 'motto-ansi-standalone');
  element.classList.toggle('motto-ansi-partial', preview !== undefined);
  const pre = element.querySelector<HTMLElement>('pre')!;
  const code = pre.querySelector<HTMLElement>('code')!;
  const numbered = shouldShowLineNumbers(settings.lineNumbers, block.lineCount);
  const layout = numbered || preview !== undefined
    ? new ReadingCodeLayout(pre, code, block.lineCount, numbered, preview)
    : null;
  return { element, destroy: () => { layout?.destroy(); } };
}

export function cloneCodeRange(code: HTMLElement, from: number, to: number): DocumentFragment {
  const document = code.ownerDocument;
  const raw = code.textContent ?? '';
  const rawOffset = (offset: number) => {
    let index = 0;
    for (let count = 0; count < offset && index < raw.length; count++, index++) {
      if (raw[index] === '\r' && raw[index + 1] === '\n') index++;
    }
    return index;
  };
  const start = rawOffset(from);
  const end = rawOffset(to);
  const range = document.createRange();
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let base = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= base + length) {
      range.setStart(node, start - base);
      started = true;
    }
    if (started && end <= base + length) {
      range.setEnd(node, end - base);
      let fragment = range.cloneContents();
      let ancestor = range.commonAncestorContainer;
      if (ancestor.nodeType !== Node.ELEMENT_NODE) ancestor = ancestor.parentNode!;
      while (ancestor !== code) {
        const wrapper = ancestor.cloneNode(false);
        wrapper.appendChild(fragment);
        fragment = createFragment(document);
        fragment.append(wrapper);
        ancestor = ancestor.parentNode!;
      }
      return fragment;
    }
    base += length;
  }
  throw new Error('[Motto Code Block] Command range is outside the native code.');
}
