import { Notice, setIcon } from 'obsidian';
import type { CodeBlock } from './codeblock';
import { languages, type LanguageDefinition } from './languages';
import { COLOR_MODES, shouldShowHeader, type FoldState, type MottoSettings } from './settings';

const languagesByAlias = new Map<string, LanguageDefinition>();
const languagesByLabel = new Map<string, LanguageDefinition>();
for (const [id, definition] of Object.entries(languages)) {
  for (const alias of [id, ...definition.aliases]) languagesByAlias.set(alias, definition);
  languagesByLabel.set(definition.label, definition);
}

export function languagePresentation(language: string): { label: string; icon: string | null } {
  const normalized = language.toLowerCase();
  const label = normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Plain text';
  const definition = languagesByAlias.get(normalized) ?? languagesByLabel.get(label);
  return { label: definition?.label ?? label, icon: definition?.icon ?? null };
}

export function applyHeaderStyles(header: HTMLElement, styles: MottoSettings['headerStyles']): void {
  for (const mode of COLOR_MODES) {
    const style = styles[mode];
    const background = {
      code: 'var(--code-background)',
      darker: 'color-mix(in srgb, var(--code-background), black 10%)',
      lighter: 'color-mix(in srgb, var(--code-background), white 10%)',
      custom: style.backgroundColor,
    }[style.background];
    const properties = {
      background,
      'icon-size': `${{ large: 32, medium: 28, small: 24 }[style.iconSize]}px`,
      'title-weight': style.titleBold ? 'bold' : 'normal',
      'title-style': style.titleItalic ? 'italic' : 'normal',
      'title-size': `${style.titleFontSize}px`,
      'title-color': style.overrideTitleColor ? style.titleColor : 'var(--text-normal)',
      'label-background': style.languageLabel === 'emphasized'
        ? 'rgba(0, 0, 0, 0.65)'
        : 'var(--motto-label-default-background)',
      'label-color': style.languageLabel === 'emphasized' ? '#ffffff' : 'var(--text-muted)',
    };
    for (const [name, value] of Object.entries(properties)) {
      header.style.setProperty(`--motto-${mode}-${name}`, value);
    }
  }
}

export function setHeaderFoldState(header: HTMLElement, state: FoldState): void {
  header.dataset.foldState = state;
  const toggle = header.querySelector<HTMLButtonElement>('.motto-header-toggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(state === 'expanded'));
  }
}

export function createExpandFooter(document: Document, hiddenLines: number, expand: () => void): HTMLDivElement {
  const footer = document.createElement('div');
  footer.className = 'motto-expand-footer';
  footer.contentEditable = 'false';
  const button = footer.createEl('button');
  button.className = 'motto-expand-button';
  button.type = 'button';
  button.contentEditable = 'false';
  button.textContent = `Show all (${hiddenLines} more ${hiddenLines === 1 ? 'line' : 'lines'})`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    expand();
  });
  return footer;
}

export async function copyCode(document: Document, text: string): Promise<void> {
  try {
    const clipboard = document.defaultView?.navigator.clipboard;
    if (!clipboard) throw new Error('Clipboard API is unavailable.');
    await clipboard.writeText(text);
    new Notice('Copied to your clipboard');
  } catch (error) {
    console.error('[Motto Code Block] Failed to copy code block.', error);
    new Notice('Motto Code Block: Failed to copy code block.');
  }
}

export function createHeader(
  document: Document,
  block: Pick<CodeBlock, 'language' | 'title' | 'headerStyle' | 'text' | 'hasParameters' | 'exclude' | 'terminal'>,
  settings: MottoSettings,
  folding?: { state: FoldState; toggle: (header: HTMLElement) => void },
): HTMLElement | null {
  if (block.exclude || !shouldShowHeader(settings.headerDisplay, block.hasParameters)) return null;
  const header = document.createElement('div');
  header.className = 'motto-header';
  const terminal = settings.commandBlocks ? block.terminal : undefined;
  if (terminal) header.classList.add('motto-command-header');
  applyHeaderStyles(header, settings.headerStyles);
  header.contentEditable = 'false';
  const language = languagePresentation(block.language);
  header.setAttribute('role', 'group');
  header.setAttribute('aria-label', `${block.title || language.label}: code block`);
  if (settings.showIcon) {
    const icon = header.createSpan();
    icon.className = 'motto-header-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (terminal) {
      const mark = icon.createSpan();
      mark.className = 'motto-terminal-icon';
      mark.style.maskImage = `url(${JSON.stringify(languages.shell.icon)})`;
      mark.style.setProperty('-webkit-mask-image', mark.style.maskImage);
    } else if (language.icon) {
      const image = icon.createEl('img');
      image.className = 'motto-language-icon';
      image.src = language.icon;
      image.alt = '';
      image.draggable = false;
    } else {
      setIcon(icon, language.label === 'Plain text' ? 'file-text' : 'file-code');
    }
  }
  if (settings.showLanguage) {
    const label = header.createSpan();
    label.className = 'motto-header-language';
    label.textContent = language.label;
  }
  if (block.title) {
    const title = header.createSpan();
    title.className = 'motto-header-title';
    title.textContent = block.title;
    title.title = block.title;
  }
  if (terminal && (terminal.user || terminal.host || terminal.cwd)) {
    const context = header.createSpan();
    context.className = 'motto-command-context';
    const append = (key: 'user' | 'host' | 'cwd') => {
      const value = terminal[key];
      if (!value) return;
      const field = context.createSpan();
      field.className = `motto-command-${key}`;
      field.textContent = value;
      field.title = value;
    };
    append('user');
    if (terminal.user && terminal.host) context.append('@');
    append('host');
    if ((terminal.user || terminal.host) && terminal.cwd) context.append(':');
    append('cwd');
    context.title = context.textContent;
  }
  if (block.headerStyle) {
    header.dataset.headerStyle = block.headerStyle;
    const background = header.createSpan();
    background.className = 'motto-header-background callout';
    background.dataset.callout = block.headerStyle;
    background.setAttribute('aria-hidden', 'true');
  }
  const controls = header.createSpan();
  controls.className = 'motto-header-controls';
  if (settings.showHeaderCopyButton) {
    const copy = controls.createEl('button');
    copy.className = 'motto-header-button motto-header-copy';
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy code block');
    setIcon(copy, 'copy');
    copy.addEventListener('click', (event) => {
      event.stopPropagation();
      void copyCode(document, block.text);
    });
  }
  if (folding) {
    const toggle = controls.createEl('button');
    toggle.className = 'motto-header-button motto-header-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', `${block.title || language.label}: toggle code block`);
    setHeaderFoldState(header, folding.state);
    header.addEventListener('click', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      toggle.focus();
      folding.toggle(header);
    });
    header.addEventListener('keydown', (event) => {
      if (event.target !== header && event.target !== toggle) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) folding.toggle(header);
    });
  }
  return header;
}
