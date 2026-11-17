import type { CodeBlock } from './codeblock';
import { splitCommands } from './commands';
import { cloneCodeRange, commandOutputPreview, commandTools, setOutputToggle } from './command-render';
import type { FoldState, MottoSettings } from './settings';

export class ReadingCommandView {
  private readonly pre: HTMLElement;
  private readonly view: HTMLElement;
  private readonly observer: MutationObserver;
  private readonly styles: MottoSettings['outputToggleStyles'];
  private open: boolean;

  constructor(
    pre: HTMLElement, block: CodeBlock, styles: MottoSettings['outputToggleStyles'],
    foldState: FoldState, preview: number | undefined,
    open: boolean, toggle?: () => void,
  ) {
    this.pre = pre;
    this.styles = styles;
    this.open = open;
    const document = pre.ownerDocument;
    const code = pre.querySelector<HTMLElement>(':scope > code')!;
    const view = this.view = document.createElement('div');
    view.className = 'motto-command-view';
    view.classList.toggle('motto-command-partial', preview !== undefined);
    view.classList.toggle('motto-command-output-open', open && foldState === 'expanded');
    view.hidden = foldState === 'folded' || pre.hidden;
    pre.before(view);
    const render = () => {
      const text = (code.textContent ?? '').replaceAll('\r\n', '\n');
      if (text !== block.text && text !== `${block.text}\n`) {
        console.warn('[Motto Codeblock] Command content changed; waiting for Markdown reprocessing.');
        view.hidden = true;
        pre.classList.remove('motto-command-native');
        return;
      }
      view.hidden = foldState === 'folded' || pre.hidden;
      pre.classList.add('motto-command-native');
      const commands = splitCommands(block.text);
      const cutoff = preview === undefined ? block.text.length
        : block.text.split('\n').slice(0, preview).join('\n').length;
      view.replaceChildren();
      for (const [index, command] of commands.entries()) {
        if (command.from >= cutoff) continue;
        const row = document.createElement('div');
        row.className = 'motto-command-row';
        const prompt = document.createElement('span');
        prompt.className = 'motto-command-prompt';
        prompt.setAttribute('aria-hidden', 'true');
        prompt.textContent = block.terminal?.user === 'root' ? '#' : '$';
        const commandPre = document.createElement('pre');
        const commandCode = document.createElement('code');
        commandCode.className = code.className;
        commandCode.append(cloneCodeRange(code, command.from, Math.min(command.to, cutoff)));
        commandPre.append(commandCode);
        const tools = commandTools(document, block.text.slice(command.from, command.to), this.open, this.styles,
          index === commands.length - 1 && command.to <= cutoff ? toggle : undefined);
        row.append(prompt, commandPre, tools);
        view.append(row);
      }
      if (commands.length === 0 && toggle) view.append(commandTools(document, null, this.open, this.styles, toggle));
    };
    render();
    if (toggle) {
      view.addEventListener('click', (event) => {
        const window = document.defaultView;
        if (event.button !== 0 || !window || !(event.target instanceof window.Element)) return;
        if (event.target.closest('button, a, input, textarea, select')) return;
        if (document.getSelection()?.isCollapsed === false) return;
        toggle();
      });
    }
    this.observer = new MutationObserver(render);
    this.observer.observe(code, { childList: true, characterData: true, subtree: true });
  }

  setOutputOpen(open: boolean): void {
    this.open = open;
    this.view.classList.toggle('motto-command-output-open', open);
    const button = this.view.querySelector<HTMLButtonElement>('.motto-output-toggle');
    if (button) setOutputToggle(button, open, this.styles);
  }

  destroy(): void {
    this.observer.disconnect();
    this.view.remove();
    this.pre.classList.remove('motto-command-native');
  }
}

export class ReadingOutputView {
  readonly block: CodeBlock;
  private readonly pre: HTMLElement;
  private view: ReturnType<typeof commandOutputPreview> | undefined;
  private preview: number | undefined;
  private expand: () => void;

  constructor(pre: HTMLElement, block: CodeBlock, expand: () => void) {
    this.pre = pre;
    this.block = block;
    this.expand = expand;
    pre.classList.add('motto-command-native');
  }

  setOpen(open: boolean, preview: number | undefined, expand: () => void): void {
    this.expand = expand;
    if (this.view && this.preview !== preview) {
      this.view.destroy();
      this.view.element.remove();
      this.view = undefined;
    }
    this.preview = preview;
    if (open && !this.view) {
      this.view = commandOutputPreview(this.pre.ownerDocument, this.block, preview, () => { this.expand(); });
      this.pre.before(this.view.element);
    }
    if (this.view) this.view.element.hidden = !open || this.pre.hidden;
  }

  destroy(): void {
    this.view?.destroy();
    this.view?.element.remove();
    this.pre.classList.remove('motto-command-native');
  }
}
