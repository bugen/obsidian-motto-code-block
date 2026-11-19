import { loadPrism, Notice, setIcon } from 'obsidian';
import { ansiText, renderAnsi } from './ansi';
import { copyCode, createExpandFooter } from './render';
import type { CodeBlock } from './codeblock';
import { COLOR_MODES, type MottoSettings, type OutputToggleIcon } from './settings';
import { ReadingCodeLayout, shouldShowLineNumbers } from './line-numbers';
import hippoIcon from './hippo.svg';
import { replyToHippo, updateHippoSpeech } from './hippo-speech';

export function commandCopyButton(document: Document, text: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'motto-command-button motto-command-copy';
  button.type = 'button';
  button.setAttribute('aria-label', label);
  setIcon(button, 'copy');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void copyCode(document, text);
  });
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
  button: HTMLButtonElement, open: boolean, styles: MottoSettings['outputToggleStyles'], tapMyHippo = false,
): void {
  const label = open ? 'Hide output' : 'Show output';
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', label);
  button.replaceChildren();
  for (const mode of COLOR_MODES) {
    const style = styles[mode];
    const icon = button.createSpan();
    icon.className = `motto-output-icon motto-output-icon-${mode}`;
    icon.setAttribute('aria-hidden', 'true');
    const closing = open !== style.reverseIcons;
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
  updateHippoSpeech(button, open, styles, tapMyHippo);
}

export function commandTools(
  document: Document, text: string | null, open: boolean, styles: MottoSettings['outputToggleStyles'],
  toggle?: () => void, tapMyHippo = false,
): HTMLElement {
  const tools = document.createElement('span');
  tools.className = 'motto-command-tools';
  if (toggle) {
    const button = tools.createEl('button');
    button.className = 'motto-command-button motto-output-toggle';
    button.type = 'button';
    setOutputToggle(button, open, styles, tapMyHippo);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      replyToHippo(button);
      toggle();
    });
  }
  if (text !== null) tools.append(commandCopyButton(document, text, 'Copy command'));
  return tools;
}

async function highlightOutput(code: HTMLElement): Promise<void> {
  try {
    const prism: unknown = await loadPrism();
    if (typeof prism !== 'object' || prism === null ||
        !('highlightElement' in prism) || typeof prism.highlightElement !== 'function') {
      throw new Error('Prism highlighting is unavailable.');
    }
    prism.highlightElement(code);
  } catch (error) {
    console.error('[Motto Code Block] Failed to highlight output.', error);
    new Notice('Motto Code Block: Failed to highlight output.');
  }
}

export function commandOutput(
  document: Document, text: string, edit?: () => void, language = 'ansi',
): HTMLElement {
  const output = document.createElement('div');
  output.className = 'motto-ansi-view motto-command-output';
  const tools = output.createDiv();
  tools.className = 'motto-output-tools';
  if (edit) {
    const button = tools.createEl('button');
    button.className = 'motto-command-button';
    button.type = 'button';
    button.setAttribute('aria-label', 'Edit source');
    setIcon(button, 'pencil');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      edit();
    });
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
): { element: HTMLElement; destroy: () => void } {
  const element = commandOutput(document, block.text, edit, block.language);
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
  const element = commandOutput(document, block.text, edit);
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
        fragment = document.createDocumentFragment();
        fragment.append(wrapper);
        ancestor = ancestor.parentNode!;
      }
      return fragment;
    }
    base += length;
  }
  throw new Error('[Motto Code Block] Command range is outside the native code.');
}
