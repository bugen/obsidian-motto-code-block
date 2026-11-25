import { Menu, setTooltip } from 'obsidian';
import { createEl } from './dom';

export type SessionOutputAction = 'open-outputs' | 'close-outputs' | 'reset-outputs';
export type SessionPromptMode = 'hide' | 'inline' | 'header';

interface SessionMenuActions {
  hasOutputs: boolean;
  hasCommands: boolean;
  promptMode: SessionPromptMode | undefined;
  changeOutputs(action: SessionOutputAction): void;
  changePrompt(mode: SessionPromptMode): void;
  copyCommands(): void;
}

export class ReadingSessionMenu {
  private readonly button: HTMLButtonElement;
  private readonly resize: ResizeObserver;
  private frame?: HTMLElement;
  private bounds: HTMLElement[] = [];
  private menu: Menu | undefined;

  constructor(document: Document, getActions: () => SessionMenuActions | undefined) {
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
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const actions = getActions();
      if (actions) this.show(actions);
    });
  }

  attach(frame: HTMLElement, controls: HTMLElement): void {
    controls.append(this.button);
    if (frame !== this.frame) {
      this.disconnect();
      this.frame = frame;
      this.resize.observe(frame);
      const win = frame.ownerDocument.defaultView;
      if (win) {
        for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
          if (parent.matches('.markdown-preview-view, .markdown-embed') ||
              /^(hidden|clip|auto|scroll)$/.test(win.getComputedStyle(parent).overflowX)) {
            this.bounds.push(parent);
            this.resize.observe(parent);
          }
          if (parent.matches('.markdown-preview-view')) break;
        }
      }
    }
    this.placeButton();
  }

  private placeButton(): void {
    const frame = this.frame;
    const win = frame?.ownerDocument.defaultView;
    if (!frame || !win) return;
    const rect = frame.getBoundingClientRect();
    const rtl = win.getComputedStyle(frame).direction === 'rtl';
    const room = this.availableSpace(rect, rtl);
    // The side placement needs room for the button, its offset, and a 4 px buffer.
    frame.classList.toggle('motto-session-menu-side', rect.width > 0 && room >= 44);
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

  private show(actions: SessionMenuActions): void {
    this.menu?.hide();
    const menu = this.menu = new Menu().setUseNativeMenu(false);
    const run = (action: () => void) => () => {
      action();
      if (this.button.isConnected) this.button.focus({ preventScroll: true });
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
      menu.addItem((item) => item.setTitle(`Prompt: ${prompts[mode]}`).setChecked(actions.promptMode === mode)
        .onClick(run(() => actions.changePrompt(mode))));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Copy all commands').setIcon('copy').setDisabled(!actions.hasCommands)
      .onClick(run(actions.copyCommands)));
    menu.onHide(() => {
      if (this.menu !== menu) return;
      this.menu = undefined;
      this.button.setAttribute('aria-expanded', 'false');
    });
    this.button.setAttribute('aria-expanded', 'true');
    const rect = this.button.getBoundingClientRect();
    const rtl = this.button.ownerDocument.defaultView?.getComputedStyle(this.button).direction === 'rtl';
    const beside = this.availableSpace(rect, rtl === true) >= 240;
    menu.showAtPosition(beside
      ? { x: rect.left, y: rect.top, width: rect.width, left: rtl }
      : { x: rect.left, y: rect.bottom, width: rect.width, left: !rtl, overlap: true }, this.button.ownerDocument);
  }

  private disconnect(): void {
    this.resize.disconnect();
    this.frame?.classList.remove('motto-session-menu-side');
    this.bounds = [];
  }

  destroy(): void {
    this.menu?.hide();
    this.disconnect();
    this.button.remove();
  }
}
