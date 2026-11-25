import type { CodeBlock, CommandSessionPosition } from './codeblock';
import { formatCommandPrompt, splitCommands, type CommandRange } from './commands';
import { cloneCodeRange, commandOutputPreview, commandPrompt, commandTools, setOutputToggle } from './command-render';
import { DEFAULT_SETTINGS, type CommandSpacing, type FoldState, type MottoSettings } from './settings';
import { destroyHippoSpeech } from './hippo-speech';
import { createEl } from './dom';
import { outputPreviewLineCount, type OutputState } from './folding';
import type { ReadingSessionMenu } from './session-menu';

export function matchesReadingCode(block: CodeBlock, renderedText?: string): boolean {
  const text = renderedText?.replaceAll('\r\n', '\n');
  if (text === block.text || text === `${block.text}\n`) return true;
  return Boolean(block.terminal?.output && !block.text.trim() && !text?.trim());
}

export class ReadingCommandView {
  private readonly pre: HTMLElement;
  private readonly view: HTMLElement;
  private readonly observer: MutationObserver;
  private readonly styles: MottoSettings['outputToggleStyles'];
  private readonly tapMyHippo: boolean;
  private readonly output: CodeBlock | undefined;
  private readonly expanded: boolean;
  private outputState: OutputState | undefined;

  constructor(
    pre: HTMLElement, block: CodeBlock, wrappedCommands: Set<number>, styles: MottoSettings['outputToggleStyles'],
    foldState: FoldState, preview: number | undefined,
    outputState: OutputState | undefined, toggle?: () => void,
    tapMyHippo = false, spacing: CommandSpacing = DEFAULT_SETTINGS.commandSpacing,
    sessionMenu?: ReadingSessionMenu,
  ) {
    this.pre = pre;
    this.styles = styles;
    this.output = block.terminal?.output;
    this.outputState = outputState;
    this.expanded = foldState === 'expanded';
    this.tapMyHippo = tapMyHippo;
    const document = pre.ownerDocument;
    const view = this.view = createEl(document, 'div');
    view.className = `motto-command-view motto-command-spacing-${spacing}`;
    view.classList.toggle('motto-command-partial', preview !== undefined);
    view.classList.toggle('motto-command-output-open', this.outputState?.open === true && this.expanded);
    view.hidden = foldState === 'folded' || pre.hidden;
    pre.before(view);
    const prompt = formatCommandPrompt(block.language, block.terminal);
    if (block.terminal?.session) view.dataset.commandSession = block.terminal.session;
    const render = () => {
      const code = pre.querySelector<HTMLElement>(':scope > code');
      if (!matchesReadingCode(block, code?.textContent ?? undefined)) {
        console.warn('[Motto Code Block] Command content changed; waiting for Markdown reprocessing.');
        destroyHippoSpeech(view);
        view.hidden = true;
        pre.classList.remove('motto-command-native');
        return;
      }
      view.hidden = foldState === 'folded' || pre.hidden;
      pre.classList.add('motto-command-native');
      const commands = splitCommands(block.text, block.language);
      const cutoff = preview === undefined ? block.text.length
        : block.text.split('\n').slice(0, preview).join('\n').length;
      destroyHippoSpeech(view);
      view.replaceChildren();
      const renderRow = (command: CommandRange | undefined, first: boolean, toggleOutput?: () => void) => {
        const row = view.createDiv();
        row.className = 'motto-command-row';
        if (command || toggleOutput) {
          row.classList.toggle('motto-command-inline-prompt', Boolean(prompt.inlineContext));
          row.classList.toggle('motto-command-wrap', command !== undefined && wrappedCommands.has(command.from));
          row.append(commandPrompt(document, prompt, command ? () => {
            if (row.classList.toggle('motto-command-wrap')) wrappedCommands.add(command.from);
            else wrappedCommands.delete(command.from);
          } : undefined));
          const commandPre = row.createEl('pre');
          if (command && code) {
            const commandCode = commandPre.createEl('code');
            commandCode.className = code.className;
            commandCode.append(cloneCodeRange(code, command.from, Math.min(command.to, cutoff)));
          } else commandPre.setAttribute('aria-hidden', 'true');
        }
        const text = command ? block.text.slice(command.from, command.to) : toggleOutput ? '' : null;
        const tools = commandTools(document, text, this.outputState?.open === true, this.styles,
          toggleOutput, this.tapMyHippo, this.partialOutput);
        row.append(tools);
        if (first) sessionMenu?.attach(view, tools);
      };
      for (const [index, command] of commands.entries()) {
        if (!code || command.from >= cutoff) continue;
        renderRow(command, index === 0, index === commands.length - 1 && command.to <= cutoff ? toggle : undefined);
      }
      if (commands.length === 0 && (toggle || sessionMenu)) renderRow(undefined, true, toggle);
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
    this.observer.observe(pre.querySelector(':scope > code') ?? pre, { childList: true, characterData: true, subtree: true });
  }

  private get partialOutput(): boolean {
    return this.outputState?.open === true && this.output !== undefined &&
      outputPreviewLineCount(this.output, this.outputState) !== undefined;
  }

  setOutputState(state: OutputState): void {
    this.outputState = state;
    this.view.classList.toggle('motto-command-output-open', state.open && this.expanded);
    const button = this.view.querySelector<HTMLButtonElement>('.motto-output-toggle');
    if (button) setOutputToggle(button, state.open, this.styles, this.tapMyHippo, this.partialOutput);
  }

  destroy(): void {
    this.observer.disconnect();
    destroyHippoSpeech(this.view);
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

  setOpen(open: boolean, preview: number | undefined, expand: () => void, session?: CommandSessionPosition): void {
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
    if (this.view) {
      if (session) this.view.element.dataset.commandSession = session;
      else delete this.view.element.dataset.commandSession;
      this.view.element.hidden = !open || this.pre.hidden;
    }
  }

  destroy(): void {
    this.view?.destroy();
    this.view?.element.remove();
    this.pre.classList.remove('motto-command-native');
  }
}
