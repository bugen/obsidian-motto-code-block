import { Menu, setIcon, setTooltip } from 'obsidian';
import { createEl, createFragment } from './dom';
import type { CodeBlock } from './codeblock';

export type SessionOutputAction = 'open-outputs' | 'close-outputs' | 'reset-outputs';
export type SessionPromptMode = 'hide' | 'inline' | 'header';

export function withSessionPrompt(block: CodeBlock, mode?: SessionPromptMode): CodeBlock {
  if (!mode || !block.terminal) return block;
  const terminal = { ...block.terminal };
  if (mode === 'header') delete terminal.promptDisplay;
  else terminal.promptDisplay = mode;
  return { ...block, terminal };
}

export function forcesPromptHeader(block: CodeBlock, mode?: SessionPromptMode): boolean {
  const terminal = block.terminal;
  return mode === 'header' && Boolean(terminal?.promptText || terminal?.user || terminal?.host || terminal?.cwd);
}

export interface SessionMenuActions {
  hasOutputs: boolean;
  hasCommands: boolean;
  changeOutputs(action: SessionOutputAction): void;
  changePrompt(mode: SessionPromptMode): void;
  writePrompt?(mode: SessionPromptMode): void;
  copyCommands(): void;
}

export class SessionMenu {
  private readonly button: HTMLButtonElement;
  private readonly resize: ResizeObserver;
  private frame?: HTMLElement;
  private editorHost: HTMLElement | undefined;
  private bounds: HTMLElement[] = [];
  private menu: Menu | undefined;
  private readonly triggerPressesWhileOpen = new WeakSet<PointerEvent>();

  constructor(document: Document, getActions: () => SessionMenuActions | undefined, refocus?: () => void) {
    const button = this.button = createEl(document, 'button');
    button.className = 'motto-command-button motto-session-menu';
    button.type = 'button';
    button.setAttribute('aria-label', 'Terminal session actions');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const icon = button.createSvg('svg');
    icon.classList.add('svg-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('fill', 'none');
    const lines = icon.createSvg('path');
    lines.setAttribute('d', 'M4 8.5h16 M4 15.5h16');
    lines.setAttribute('stroke', 'currentColor');
    lines.setAttribute('stroke-width', '2.1');
    lines.setAttribute('stroke-linecap', 'round');
    setTooltip(button, 'Terminal session actions');
    this.resize = new ResizeObserver(() => this.placeButton());
    let closeOnClick = false;
    button.addEventListener('pointerdown', (event) => {
      closeOnClick = this.triggerPressesWhileOpen.has(event);
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const closing = this.menu !== undefined || (event.detail > 0 && closeOnClick);
      closeOnClick = false;
      if (closing) {
        this.menu?.hide();
        button.focus({ preventScroll: true });
        return;
      }
      const actions = getActions();
      if (actions) this.show(actions, refocus);
    });
  }

  attach(frame: HTMLElement, controls: HTMLElement, editorHost?: HTMLElement): void {
    if (this.button.parentElement !== controls) controls.append(this.button);
    if (frame !== this.frame || editorHost !== this.editorHost) {
      const previousTarget = this.editorHost ?? this.frame;
      if (previousTarget !== (editorHost ?? frame)) previousTarget?.classList.remove('motto-session-menu-side');
      this.disconnect();
      this.frame = frame;
      this.editorHost = editorHost;
      this.resize.observe(frame);
      const win = frame.ownerDocument.defaultView;
      if (win) {
        for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
          if (parent.matches('.markdown-preview-view, .markdown-embed, .cm-scroller') ||
              /^(hidden|clip|auto|scroll)$/.test(win.getComputedStyle(parent).overflowX)) {
            this.bounds.push(parent);
            this.resize.observe(parent);
          }
          if (parent.matches('.markdown-preview-view, .cm-scroller')) break;
        }
      }
    }
    this.placeButton();
  }

  mount(controls: HTMLElement): void {
    controls.append(this.button);
  }

  private placeButton(): void {
    const frame = this.frame;
    const win = frame?.ownerDocument.defaultView;
    if (!frame || !win) return;
    const rect = frame.getBoundingClientRect();
    const rtl = win.getComputedStyle(frame).direction === 'rtl';
    const room = this.availableSpace(rect, rtl);
    // CodeMirror owns the line's attributes. Use its widget for state and keep a fitting button in place near the threshold.
    const target = this.editorHost ?? frame;
    const buffer = this.editorHost && target.classList.contains('motto-session-menu-side') ? 0 : 4;
    target.classList.toggle('motto-session-menu-side', rect.width > 0 && room >= 38 + 6 + buffer);
  }

  private availableSpace(rect: DOMRect, left: boolean): number {
    const root = this.button.ownerDocument.documentElement;
    const edge = this.bounds.reduce((limit, element) => {
      if (!element.clientWidth) return limit;
      const start = element.getBoundingClientRect().left + element.clientLeft;
      return left ? Math.max(limit, start) : Math.min(limit, start + element.clientWidth);
    }, left ? 0 : root.clientWidth);
    return left ? rect.left - edge : edge - rect.right;
  }

  private show(actions: SessionMenuActions, refocus?: () => void): void {
    const menu = this.menu = new Menu().setUseNativeMenu(false);
    const run = (action: () => void) => () => {
      action();
      if (this.button.isConnected) this.button.focus({ preventScroll: true });
      else refocus?.();
    };
    const output = (action: SessionOutputAction, title: string) => {
      menu.addItem((item) => item.setTitle(title).setDisabled(!actions.hasOutputs)
        .onClick(run(() => actions.changeOutputs(action))));
    };
    output('open-outputs', 'Open all outputs');
    output('close-outputs', 'Close all outputs');
    output('reset-outputs', 'Reset output states');
    menu.addSeparator();
    const prompts = { hide: 'Hide', inline: 'Inline', header: 'Header' } as const;
    for (const mode of ['hide', 'inline', 'header'] as const) {
      const title = `Prompt: ${prompts[mode]}`;
      const write = actions.writePrompt;
      const label = write ? this.promptLabel(title, () => {
        menu.hide();
        run(() => write(mode))();
      }) : title;
      menu.addItem((item) => item.setTitle(label)
        .onClick(run(() => actions.changePrompt(mode))));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Copy all commands').setIcon('copy').setDisabled(!actions.hasCommands)
      .onClick(run(actions.copyCommands)));
    const document = this.button.ownerDocument;
    const win = document.defaultView;
    // Obsidian may dismiss the menu on this press before the trigger receives its click.
    const rememberPress = (event: PointerEvent) => {
      if (event.button === 0 && event.composedPath().includes(this.button)) this.triggerPressesWhileOpen.add(event);
    };
    win?.addEventListener('pointerdown', rememberPress, true);
    menu.onHide(() => {
      win?.removeEventListener('pointerdown', rememberPress, true);
      if (this.menu !== menu) return;
      this.menu = undefined;
      this.button.setAttribute('aria-expanded', 'false');
    });
    this.button.setAttribute('aria-expanded', 'true');
    const rect = this.button.getBoundingClientRect();
    const rtl = win?.getComputedStyle(this.button).direction === 'rtl';
    const beside = this.availableSpace(rect, rtl === true) >= 240;
    menu.showAtPosition(beside
      ? { x: rect.left, y: rect.top, width: rect.width, left: rtl }
      : { x: rect.left, y: rect.bottom, width: rect.width, left: !rtl, overlap: true }, document);
  }

  private promptLabel(title: string, write: () => void): DocumentFragment {
    const document = this.button.ownerDocument;
    const label = createFragment(document);
    const row = label.createSpan();
    row.className = 'motto-session-prompt-label';
    row.append(title);
    const pencil = row.createEl('button');
    pencil.className = 'motto-session-prompt-write';
    pencil.type = 'button';
    const description = 'Write to all grouped blocks';
    pencil.setAttribute('aria-label', description);
    setTooltip(pencil, description);
    setIcon(pencil, 'pencil');
    pencil.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    });
    pencil.addEventListener('mousedown', (event) => { event.stopPropagation(); });
    pencil.addEventListener('click', (event) => {
      event.stopPropagation();
      write();
    });
    return label;
  }

  private disconnect(): void {
    this.resize.disconnect();
    this.bounds = [];
  }

  destroy(): void {
    this.menu?.hide();
    this.disconnect();
    (this.editorHost ?? this.frame)?.classList.remove('motto-session-menu-side');
    this.button.remove();
  }
}
