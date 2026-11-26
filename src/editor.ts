import { EditorSelection, MapMode, Prec, StateEffect, StateField, Text, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { editorInfoField, editorLivePreviewField, Notice, type Editor } from 'obsidian';
import { encodeAnsiSource, hasAnsiControls } from './ansi-text';
import { isCodeBlockEnabled, parseCodeBlocks, reportDiagnostics, type CodeBlock } from './codeblock';
import { applyHeaderStyles, createExpandFooter, createHeader, setHeaderFoldState } from './render';
import { shouldShowHeader, type FoldState, type MottoSettings } from './settings';
import { createLineNumber, lineNumberWidth, shouldShowLineNumbers } from './line-numbers';
import { hasFoldableHeader, initialOutputState, nextFoldState, nextOutputState, noteFoldOverride, noteOutputOverride, outputPreviewLineCount, previewLineCount, resolveFoldState, type NoteFoldAction, type OutputState } from './folding';
import { formatCommandPrompt, splitCommands, type CommandPrompt, type CommandRange } from './commands';
import { ansiPreview, commandOutputPreview, commandPrompt, commandTools, outputToggleClasses, setOutputToggle, terminalDeleteButton, terminalEditButton } from './command-render';
import { destroyHippoSpeech } from './hippo-speech';
import { createEl } from './dom';

interface HeaderState {
  livePreview: boolean;
  blocks: CodeBlock[];
  folds: Map<number, FoldState>;
  overrides: Map<number, FoldState>;
  outputs: Map<number, OutputState>;
  ansiEditing: Set<number>;
  commandWraps: Map<number, boolean>;
  decorations: DecorationSet;
  commandScrolls: DecorationSet;
}

const toggleFold = StateEffect.define<number>();
const changeOutput = StateEffect.define<{ from: number; action: 'toggle' | 'expand' }>();
const changeCommandWrap = StateEffect.define<{ from: number; wrap: boolean }>();
const changeNoteFolds = StateEffect.define<NoteFoldAction>();

type DeleteTerminalBlock = (view: EditorView, commandFrom: number, scope: 'block' | 'output') => void;
const deleteBlockLabel = 'Delete command block and its output';

function measureDeleteButtonPlacement(view: EditorView): void {
  view.requestMeasure({
    key: measureDeleteButtonPlacement,
    read: ({ contentDOM, scrollDOM }) => {
      const buttons = contentDOM.querySelectorAll<HTMLButtonElement>('.motto-command-delete-anchor > button.motto-terminal-delete');
      const frame = scrollDOM.getBoundingClientRect();
      const document = scrollDOM.ownerDocument;
      const left = Math.max(0, frame.left + scrollDOM.clientLeft);
      const right = Math.min(document.documentElement.clientWidth, frame.left + scrollDOM.clientLeft + scrollDOM.clientWidth);
      return [...buttons].map((button) => {
        const line = button.parentElement!;
        const bounds = line.getBoundingClientRect();
        const rtl = document.defaultView?.getComputedStyle(line).direction === 'rtl';
        const room = rtl ? bounds.left - left : right - bounds.right;
        // A 28 px button plus a small buffer before the pane's clipping edge.
        return { button, outside: bounds.width > 0 && right > left && room >= 30 };
      });
    },
    write: (placements) => {
      for (const { button, outside } of placements) button.classList.toggle('motto-delete-outside', outside);
    },
  });
}

function dispatchFoldClick(view: EditorView, from: number, effect: StateEffect<unknown>): void {
  // Keep the viewport from following the document bottom when a block changes height.
  const effects = typeof view.scrollSnapshot === 'function' ? [effect, view.scrollSnapshot()] : [effect];
  view.dispatch({ effects, selection: { anchor: from } });
}

class HeaderWidget extends WidgetType {
  readonly block: CodeBlock;
  readonly settings: MottoSettings;
  readonly foldState: FoldState;
  private readonly remove: DeleteTerminalBlock | undefined;

  constructor(block: CodeBlock, settings: MottoSettings, foldState: FoldState, remove?: DeleteTerminalBlock) {
    super();
    this.block = block;
    this.settings = settings;
    this.foldState = foldState;
    this.remove = remove;
  }

  private sameContent(other: HeaderWidget): boolean {
    return this.block.title === other.block.title && this.block.language === other.block.language &&
      this.block.text === other.block.text &&
      this.block.headerStyle === other.block.headerStyle &&
      this.block.terminal?.user === other.block.terminal?.user &&
      this.block.terminal?.host === other.block.terminal?.host &&
      this.block.terminal?.cwd === other.block.terminal?.cwd &&
      this.block.terminal?.promptText === other.block.terminal?.promptText &&
      this.block.terminal?.promptDisplay === other.block.terminal?.promptDisplay &&
      Boolean(this.block.terminal) === Boolean(other.block.terminal) && this.remove === other.remove &&
      this.settings.commandBlocks === other.settings.commandBlocks &&
      this.settings.showIcon === other.settings.showIcon && this.settings.showLanguage === other.settings.showLanguage &&
      this.settings.showHeaderCopyButton === other.settings.showHeaderCopyButton;
  }

  override eq(other: HeaderWidget): boolean {
    return this.sameContent(other) && this.foldState === other.foldState &&
      this.settings.headerStyles === other.settings.headerStyles;
  }

  override updateDOM(header: HTMLElement, _view: EditorView, previous: HeaderWidget): boolean {
    if (!this.sameContent(previous)) return false;
    applyHeaderStyles(header, this.settings.headerStyles);
    setHeaderFoldState(header, this.foldState);
    return true;
  }

  override toDOM(view: EditorView): HTMLElement {
    const header = createHeader(view.dom.ownerDocument, this.block, this.settings, {
      state: this.foldState,
      toggle: (header) => {
        const from = view.posAtDOM(header);
        dispatchFoldClick(view, from, toggleFold.of(from));
      },
    });
    if (!header) throw new Error('[Motto Code Block] Cannot mount a disabled header.');
    const remove = this.remove;
    if (remove) {
      header.querySelector('.motto-header-controls')?.prepend(terminalDeleteButton(view.dom.ownerDocument,
        deleteBlockLabel, () => { remove(view, view.posAtDOM(header), 'block'); }));
    }
    return header;
  }
}

class LineNumberWidget extends WidgetType {
  private readonly number: number;

  constructor(number: number) {
    super();
    this.number = number;
  }

  override eq(other: LineNumberWidget): boolean { return this.number === other.number; }

  override toDOM(view: EditorView): HTMLElement {
    return createLineNumber(view.dom.ownerDocument, this.number);
  }
}

class ExpandWidget extends WidgetType {
  private readonly from: number;
  private readonly hiddenLines: number;

  constructor(from: number, hiddenLines: number) {
    super();
    this.from = from;
    this.hiddenLines = hiddenLines;
  }

  override eq(other: ExpandWidget): boolean {
    return this.from === other.from && this.hiddenLines === other.hiddenLines;
  }

  override toDOM(view: EditorView): HTMLElement {
    return createExpandFooter(view.dom.ownerDocument, this.hiddenLines, () => {
      dispatchFoldClick(view, this.from, toggleFold.of(this.from));
      view.focus();
    });
  }
}

interface EmptyCommandControls {
  editAt?: number;
  remove?: DeleteTerminalBlock;
}

function commandPromptStyle(prompt: CommandPrompt): string {
  return prompt.inlineContext
    ? `--motto-command-prompt-width: ${Array.from(prompt.inlineContext + prompt.symbol).length}ch;` : '';
}

class CommandWidget extends WidgetType {
  readonly from: number;
  readonly text: string | null;
  readonly prompt: CommandPrompt;
  readonly output: boolean;
  readonly open: boolean;
  readonly partial: boolean;
  readonly styles: MottoSettings['outputToggleStyles'];
  readonly tapMyHippo: boolean;
  private readonly emptyControls: EmptyCommandControls | undefined;

  constructor(
    from: number, text: string | null, prompt: CommandPrompt, output: boolean, open: boolean, partial: boolean,
    styles: MottoSettings['outputToggleStyles'], tapMyHippo: boolean, emptyControls?: EmptyCommandControls,
  ) {
    super();
    this.from = from;
    this.text = text;
    this.prompt = prompt;
    this.output = output;
    this.open = open;
    this.partial = partial;
    this.styles = styles;
    this.tapMyHippo = tapMyHippo;
    this.emptyControls = emptyControls;
  }

  private sameContent(other: CommandWidget): boolean {
    return this.from === other.from && this.text === other.text &&
      this.prompt.symbol === other.prompt.symbol && this.prompt.inlineContext === other.prompt.inlineContext &&
      this.prompt.tooltip === other.prompt.tooltip &&
      this.output === other.output && this.emptyControls?.editAt === other.emptyControls?.editAt &&
      this.emptyControls?.remove === other.emptyControls?.remove;
  }

  override eq(other: CommandWidget): boolean {
    return this.sameContent(other) && this.open === other.open && this.partial === other.partial && this.styles === other.styles &&
      this.tapMyHippo === other.tapMyHippo;
  }

  override updateDOM(marker: HTMLElement, _view: EditorView, previous: CommandWidget): boolean {
    if (!this.sameContent(previous)) return false;
    const button = marker.querySelector<HTMLButtonElement>('.motto-output-toggle');
    if (button) setOutputToggle(button, this.open, this.styles, this.tapMyHippo, this.partial);
    return true;
  }

  override toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const marker = createEl(document, 'span');
    marker.className = 'motto-command-marker';
    marker.contentEditable = 'false';
    if (this.text !== null) {
      marker.append(commandPrompt(document, this.prompt, () => {
        const from = view.state.doc.lineAt(view.posAtDOM(marker)).from;
        const line = marker.closest('.cm-line');
        const whiteSpace = line && document.defaultView?.getComputedStyle(line).whiteSpace;
        const wrapping = line?.classList.contains('motto-command-wrap') ||
          (!line?.classList.contains('motto-command-nowrap') &&
            (whiteSpace ? whiteSpace !== 'pre' && whiteSpace !== 'nowrap' : view.lineWrapping));
        view.dispatch({ effects: changeCommandWrap.of({ from, wrap: !wrapping }) });
      }));
    } else {
      marker.append(commandPrompt(document, this.prompt));
    }
    const tools = commandTools(document, this.text ?? '', this.open, this.styles, this.output ? () => {
      dispatchFoldClick(view, this.from, changeOutput.of({ from: this.from, action: 'toggle' }));
    } : undefined, this.tapMyHippo, this.partial);
    marker.append(tools);
    if (this.text !== null) return marker;

    const row = createEl(document, 'div');
    row.className = 'motto-command-line motto-command-empty-line';
    row.contentEditable = 'false';
    row.style.cssText = commandPromptStyle(this.prompt);
    row.append(marker);
    const { editAt, remove } = this.emptyControls ?? {};
    if (editAt !== undefined) tools.prepend(terminalEditButton(document, 'Edit command source', () => {
      view.dispatch({ selection: { anchor: editAt } });
      view.focus();
    }));
    if (remove) {
      row.classList.add('motto-command-delete-anchor');
      row.append(terminalDeleteButton(document, deleteBlockLabel, () => { remove(view, this.from, 'block'); }));
    }
    return row;
  }

  override destroy(marker: HTMLElement): void {
    destroyHippoSpeech(marker);
  }
}

class DeleteCommandWidget extends WidgetType {
  private readonly from: number;
  private readonly remove: DeleteTerminalBlock;

  constructor(from: number, remove: DeleteTerminalBlock) {
    super();
    this.from = from;
    this.remove = remove;
  }

  override eq(other: DeleteCommandWidget): boolean { return this.from === other.from && this.remove === other.remove; }

  override toDOM(view: EditorView): HTMLElement {
    return terminalDeleteButton(view.dom.ownerDocument, deleteBlockLabel, () => { this.remove(view, this.from, 'block'); });
  }
}

class OutputWidget extends WidgetType {
  private static readonly previews = new WeakMap<HTMLElement, ReturnType<typeof commandOutputPreview>>();
  readonly commandFrom: number;
  readonly block: CodeBlock;
  readonly preview: number | undefined;
  private readonly remove: DeleteTerminalBlock | undefined;

  constructor(commandFrom: number, block: CodeBlock, preview: number | undefined, remove?: DeleteTerminalBlock) {
    super();
    this.commandFrom = commandFrom;
    this.block = block;
    this.preview = preview;
    this.remove = remove;
  }

  override eq(other: OutputWidget): boolean {
    return this.commandFrom === other.commandFrom && this.block.from === other.block.from &&
      this.block.language === other.block.language && this.block.ansiRaw === other.block.ansiRaw &&
      this.block.startLine === other.block.startLine && this.block.text === other.block.text &&
      this.block.lineCount === other.block.lineCount && this.preview === other.preview && this.remove === other.remove;
  }

  override toDOM(view: EditorView): HTMLElement {
    const remove = this.remove;
    const preview = commandOutputPreview(view.dom.ownerDocument, this.block, this.preview, () => {
      dispatchFoldClick(view, this.commandFrom, changeOutput.of({ from: this.commandFrom, action: 'expand' }));
      view.focus();
    }, () => { editOutput(view, this.block); }, remove ? () => { remove(view, this.commandFrom, 'output'); } : undefined);
    OutputWidget.previews.set(preview.element, preview);
    return preview.element;
  }

  override destroy(dom: HTMLElement): void {
    OutputWidget.previews.get(dom)?.destroy();
    OutputWidget.previews.delete(dom);
  }
}

class AnsiWidget extends WidgetType {
  private static readonly previews = new WeakMap<HTMLElement, ReturnType<typeof ansiPreview>>();
  readonly block: CodeBlock;
  readonly settings: MottoSettings;
  readonly preview: number | undefined;

  constructor(block: CodeBlock, settings: MottoSettings, preview: number | undefined) {
    super();
    this.block = block;
    this.settings = settings;
    this.preview = preview;
  }

  override eq(other: AnsiWidget): boolean {
    return this.block.from === other.block.from && this.block.to === other.block.to &&
      this.block.startLine === other.block.startLine && this.block.text === other.block.text &&
      this.block.ansiRaw === other.block.ansiRaw && this.settings.lineNumbers === other.settings.lineNumbers &&
      this.preview === other.preview;
  }

  override toDOM(view: EditorView): HTMLElement {
    const preview = ansiPreview(view.dom.ownerDocument, this.block, this.settings, this.preview,
      () => { editOutput(view, this.block, this.preview !== undefined); });
    AnsiWidget.previews.set(preview.element, preview);
    return preview.element;
  }

  override destroy(dom: HTMLElement): void {
    AnsiWidget.previews.get(dom)?.destroy();
    AnsiWidget.previews.delete(dom);
  }
}

function bodyStart(block: CodeBlock, state: EditorState): number {
  const line = block.startLine + 2;
  return line <= state.doc.lines ? state.doc.line(line).from : block.to;
}

function pasteAnsi(event: ClipboardEvent, view: EditorView, settings: MottoSettings): boolean {
  const { state } = view;
  const clipboard = event.clipboardData;
  if (state.readOnly || !clipboard || clipboard.files.length > 0) return false;
  const original = clipboard.getData('text/plain');
  const text = original.replaceAll('\r\n', '\n');
  if (!text.includes('\\') && !hasAnsiControls(text)) return false;
  const bodies = parseCodeBlocks(state.doc.toString(), settings).blocks
    .filter((block) => block.language === 'ansi' && !block.ansiRaw &&
      isCodeBlockEnabled(block, settings) && !hasAnsiControls(block.text))
    .map((block) => ({
      from: state.doc.line(block.startLine + 1).to + 1,
      to: block.unclosed ? block.to : state.doc.line(block.endLine).to,
    }));
  if (bodies.length === 0) return false;
  const lines = text.split('\n');
  const byLine = lines.length === state.selection.ranges.length;
  let index = 0;
  let converted = false;
  const change = state.changeByRange(({ from, to }) => {
    const input = byLine ? lines[index++]! : text;
    const encoded = bodies.some((body) => from >= body.from && to <= body.to) ? encodeAnsiSource(input) : input;
    converted ||= encoded !== input;
    const insert = encoded !== input ? Text.of(encoded.split('\n')) : state.toText(byLine ? input : original);
    return { changes: { from, to, insert }, range: EditorSelection.cursor(from + insert.length, -1) };
  });
  if (!converted) return false;
  view.dispatch({ ...change, scrollIntoView: true, userEvent: 'input.paste' });
  return true;
}

function editOutput(view: EditorView, block: CodeBlock, expand = false): void {
  view.dispatch({
    selection: { anchor: bodyStart(block, view.state) },
    effects: expand ? toggleFold.of(block.from) : [],
  });
  view.focus();
}

function commandEnd(block: CodeBlock, settings: MottoSettings): number {
  return settings.commandBlocks ? block.terminal?.output?.to ?? block.to : block.to;
}

function insideOutput(block: CodeBlock, state: EditorState, from = block.from): boolean {
  return state.selection.ranges.some(({ anchor, head }) =>
    (anchor >= from && anchor <= block.to) || (head >= from && head <= block.to));
}

function editingAnsiBlocks(
  blocks: CodeBlock[], settings: MottoSettings, state: EditorState, previous = new Set<number>(),
): Set<number> {
  const editing = new Set<number>();
  for (const block of blocks) {
    if (block.language !== 'ansi' || (settings.commandBlocks && (block.terminal || block.commandFrom !== undefined))) continue;
    // Keep the opening boundary editable once source editing has begun; headers use it to return to preview.
    const from = previous.has(block.from) ? block.from : block.from + 1;
    if (insideOutput(block, state, from)) editing.add(block.from);
  }
  return editing;
}

function outputStates(
  blocks: CodeBlock[], settings: MottoSettings, state: EditorState, previous = new Map<number, OutputState>(),
): Map<number, OutputState> {
  const outputs = new Map<number, OutputState>();
  if (!settings.commandBlocks) return outputs;
  for (const block of blocks) {
    const output = block.terminal?.output;
    if (output) outputs.set(block.from, insideOutput(output, state)
      ? { open: true, fullyExpanded: true } : previous.get(block.from) ?? initialOutputState(output));
  }
  return outputs;
}

function hiddenBodyContainsSelection(block: CodeBlock, settings: MottoSettings, state: EditorState, fold: FoldState): boolean {
  if (fold === 'expanded') return false;
  const from = fold === 'partial'
    ? state.doc.line(block.startLine + previewLineCount(block, settings) + 2).from : block.from + 1;
  const to = commandEnd(block, settings) +
    (fold === 'partial' || block.language === 'ansi' ||
      (settings.commandBlocks && block.terminal?.output !== undefined) ? 1 : 0);
  return state.selection.ranges.some(({ anchor, head }) =>
    (anchor >= from && anchor < to) || (head >= from && head < to));
}

function foldedBlocks(
  blocks: CodeBlock[], settings: MottoSettings, state: EditorState, overrides: Map<number, FoldState>,
): Map<number, FoldState> {
  const folds = new Map<number, FoldState>();
  for (const block of blocks) {
    if (settings.commandBlocks && block.commandFrom !== undefined) continue;
    const foldState = resolveFoldState(block, settings, overrides.get(block.from));
    if (foldState === 'expanded') continue;
    if (hiddenBodyContainsSelection(block, settings, state, foldState)) {
      overrides.set(block.from, 'expanded');
    } else folds.set(block.from, foldState);
  }
  return folds;
}

function decorate(
  blocks: CodeBlock[], settings: MottoSettings, folds: Map<number, FoldState>, state: EditorState,
  outputs: Map<number, OutputState>, ansiEditing: Set<number>, commandWraps: Map<number, boolean>,
  remove: DeleteTerminalBlock,
): Pick<HeaderState, 'decorations' | 'commandScrolls'> {
  const decorations: Range<Decoration>[] = [];
  const commandScrolls: Range<Decoration>[] = [];
  for (const block of blocks) {
    if (settings.commandBlocks && block.commandFrom !== undefined) continue;
    const foldState = folds.get(block.from) ?? 'expanded';
    const terminal = settings.commandBlocks ? block.terminal : undefined;
    const canRemoveBlock = terminal && !state.readOnly && !block.unclosed && !terminal.output?.unclosed;
    const preview = foldState === 'partial' ? previewLineCount(block, settings) : undefined;
    const hasHeader = shouldShowHeader(settings.headerDisplay, block.hasParameters);
    if (hasHeader) {
      decorations.push(Decoration.widget({
        widget: new HeaderWidget(block, settings, foldState, canRemoveBlock && foldState === 'folded' ? remove : undefined),
        block: true, side: -1,
      }).range(block.from));
      decorations.push(foldState === 'folded'
        ? Decoration.replace({ block: true }).range(block.from, commandEnd(block, settings))
        : Decoration.line({ class: 'motto-code-block-start' }).range(block.from));
    }
    if (foldState === 'folded') continue;
    if (block.language === 'ansi' && !terminal && !ansiEditing.has(block.from)) {
      decorations.push(Decoration.replace({
        widget: new AnsiWidget(block, settings, preview), block: true,
      }).range(block.from, block.to));
      if (preview !== undefined) decorations.push(Decoration.widget({
        widget: new ExpandWidget(block.from, block.lineCount - preview), block: true, side: 1,
      }).range(block.to));
      continue;
    }
    if (preview !== undefined) {
      decorations.push(Decoration.line({ attributes: {
        class: 'motto-preview-end',
        style: `--motto-preview-lines: ${preview}`,
      } }).range(state.doc.line(block.startLine + preview + 1).from));
      const from = state.doc.line(block.startLine + preview + 2).from;
      decorations.push(Decoration.replace({
        block: true, widget: new ExpandWidget(block.from, block.lineCount - preview),
      }).range(from, block.to));
    }
    if (terminal) {
      decorations.push(Decoration.line({ class: 'motto-command-start' }).range(block.from));
      const commands = splitCommands(block.text, block.language);
      const prompt = formatCommandPrompt(block.language, terminal);
      const output = terminal.output;
      const outputState = outputs.get(block.from);
      const open = outputState?.open === true;
      const outputPreview = output && outputState ? outputPreviewLineCount(output, outputState) : undefined;
      const partialOutput = open && outputPreview !== undefined;
      const count = preview ?? block.lineCount;
      const emptyPreview = output !== undefined && commands.length === 0 &&
        !insideOutput(block, state, block.from + 1);
      if (emptyPreview) {
        // Exclude the opening boundary so toggling the output does not reveal the empty command's fences.
        const editAt = block.lineCount === 0 ? state.doc.line(block.startLine + 1).to : bodyStart(block, state);
        decorations.push(Decoration.replace({
          block: true, widget: new CommandWidget(block.from, null, prompt, true, open, partialOutput,
            settings.outputToggleStyles, settings.tapMyHippo, {
              ...(!state.readOnly ? { editAt } : {}),
              ...(canRemoveBlock ? { remove } : {}),
            }),
        }).range(block.from, block.to));
      } else if (canRemoveBlock) {
        const first = commands[0];
        const anchor = first && first.startLine < count ? state.doc.line(block.startLine + first.startLine + 2).from : block.from;
        decorations.push(Decoration.line({ class: 'motto-command-delete-anchor' }).range(anchor));
        decorations.push(Decoration.widget({ widget: new DeleteCommandWidget(block.from, remove), side: -1 }).range(anchor));
      }
      const promptWidth = commandPromptStyle(prompt);
      const lastCommand = commands[commands.length - 1];
      let commandIndex = 0;
      let command: CommandRange | undefined = commands[0];
      let wrap: boolean | undefined;
      for (let line = 0; line < count; line++) {
        const { from, to } = state.doc.line(block.startLine + line + 2);
        if (command && line > command.endLine) {
          command = commands[++commandIndex];
          wrap = undefined;
        }
        if (command?.startLine === line) wrap = commandWraps.get(from);
        const withToggle = output !== undefined && lastCommand?.startLine === line && lastCommand.endLine < count;
        decorations.push(Decoration.line({ attributes: {
          class: `motto-command-line${wrap === undefined ? '' : wrap ? ' motto-command-wrap' : ' motto-command-nowrap'}` +
            (withToggle ? ` ${outputToggleClasses(settings.outputToggleStyles)}` : ''),
          style: `${promptWidth}--motto-command-tools-width: ${withToggle ? '68px' : '36px'}`,
        } }).range(from));
        if (wrap === false && from < to) {
          commandScrolls.push(Decoration.mark({ class: 'motto-command-scroll' }).range(from, to));
        }
      }
      for (const [index, command] of commands.entries()) {
        if (command.startLine >= count) continue;
        const next = commands[index + 1];
        if (settings.commandSpacing !== 'small' && next && next.startLine < count) {
          decorations.push(Decoration.line({
            class: `motto-command-gap motto-command-spacing-${settings.commandSpacing}`,
          }).range(state.doc.line(block.startLine + command.endLine + 2).from));
        }
        decorations.push(Decoration.widget({
          widget: new CommandWidget(block.from, block.text.slice(command.from, command.to), prompt,
            output !== undefined && index === commands.length - 1 && command.endLine < count, open, partialOutput,
            settings.outputToggleStyles, settings.tapMyHippo),
          side: -1,
        }).range(state.doc.line(block.startLine + command.startLine + 2).from));
      }
      if (output) {
        if (!open || preview !== undefined) {
          decorations.push(Decoration.replace({ block: true }).range(output.from, output.to));
        } else if (insideOutput(output, state)) {
          for (let line = output.startLine; line <= output.endLine; line++) {
            decorations.push(Decoration.line({ class: 'motto-command-output-source' }).range(state.doc.line(line + 1).from));
          }
        } else decorations.push(Decoration.replace({
          block: true, widget: new OutputWidget(block.from, output, outputPreview, state.readOnly || output.unclosed ? undefined : remove),
        }).range(output.from, output.to));
      }
      continue;
    }
    if (!shouldShowLineNumbers(settings.lineNumbers, block.lineCount)) continue;
    for (let number = 1; number <= (preview ?? block.lineCount); number++) {
      const from = state.doc.line(block.startLine + number + 1).from;
      decorations.push(Decoration.line({ attributes: {
        class: 'motto-numbered-line',
        style: `--motto-line-number-width: ${lineNumberWidth(block.lineCount)}`,
      } }).range(from));
      decorations.push(Decoration.widget({ widget: new LineNumberWidget(number), side: -1 }).range(from));
    }
  }
  return {
    decorations: Decoration.set(decorations, true),
    commandScrolls: Decoration.set(commandScrolls, true),
  };
}

export function createEditorHeaders(getSettings: () => MottoSettings): {
  extension: Extension; refresh: () => void;
  setNoteFolds: (editor: Editor, action: NoteFoldAction, checking: boolean) => boolean;
} {
  const refresh = StateEffect.define<null>();
  const views = new Set<EditorView>();
  function readBlocks(livePreview: boolean, source: string): CodeBlock[] {
    if (!livePreview) return [];
    const settings = getSettings();
    const result = parseCodeBlocks(source, settings);
    reportDiagnostics(result.diagnostics, 'editor');
    return result.blocks.filter((block) => isCodeBlockEnabled(block, settings));
  }
  const field = StateField.define<HeaderState>({
    create(state) {
      const livePreview = state.field(editorLivePreviewField, false) === true;
      const blocks = readBlocks(livePreview, state.doc.toString());
      const settings = getSettings();
      const overrides = new Map<number, FoldState>();
      const folds = foldedBlocks(blocks, settings, state, overrides);
      const outputs = outputStates(blocks, settings, state);
      const ansiEditing = editingAnsiBlocks(blocks, settings, state);
      const commandWraps = new Map<number, boolean>();
      return {
        livePreview, blocks, folds, overrides, outputs, ansiEditing, commandWraps,
        ...decorate(blocks, settings, folds, state, outputs, ansiEditing, commandWraps, remove),
      };
    },
    update(previous, transaction) {
      const livePreview = transaction.state.field(editorLivePreviewField, false) === true;
      const reparse = transaction.docChanged || livePreview !== previous.livePreview ||
        transaction.effects.some((effect) => effect.is(refresh));
      const bulkAction = transaction.effects.find((effect) => effect.is(changeNoteFolds))?.value;
      if (!reparse && transaction.startState.readOnly === transaction.state.readOnly && !bulkAction && !transaction.effects.some((effect) =>
        effect.is(toggleFold) || effect.is(changeOutput) || effect.is(changeCommandWrap)) &&
          !(transaction.selection && (previous.folds.size > 0 || previous.outputs.size > 0 ||
            previous.blocks.some((block) => block.language === 'ansi')))) return previous;
      const blocks = reparse ? readBlocks(livePreview, transaction.state.doc.toString()) : previous.blocks;
      const settings = getSettings();
      const commandWraps = new Map<number, boolean>();
      if (livePreview && settings.commandBlocks) {
        for (const [from, wrap] of previous.commandWraps) {
          const mapped = transaction.changes.mapPos(from, 1, MapMode.TrackAfter);
          if (mapped !== null) commandWraps.set(transaction.state.doc.lineAt(mapped).from, wrap);
        }
      }
      const visibleBlocks = blocks.filter((block) => hasFoldableHeader(block, settings));
      const overrides = new Map<number, FoldState>();
      for (const block of previous.blocks) {
        const override = previous.overrides.get(block.from);
        if (override === undefined) continue;
        const from = transaction.changes.mapPos(block.from, 1, MapMode.TrackAfter);
        const to = transaction.changes.mapPos(block.to, -1, MapMode.TrackBefore);
        if (from !== null && visibleBlocks.some((candidate) =>
          candidate.from === from && candidate.to === to && candidate.fold === block.fold &&
          candidate.previewLines === block.previewLines)) {
          overrides.set(from, override);
        }
      }
      if (bulkAction === 'reset-folds') overrides.clear();
      else if (bulkAction) {
        for (const block of visibleBlocks) {
          const override = noteFoldOverride(block, settings, bulkAction);
          if (override) overrides.set(block.from, override);
        }
      }
      const folds = foldedBlocks(visibleBlocks, settings, transaction.state, overrides);
      const mappedOutputs = new Map<number, OutputState>();
      for (const block of previous.blocks) {
        const output = block.terminal?.output;
        const open = previous.outputs.get(block.from);
        if (!output || open === undefined) continue;
        const from = transaction.changes.mapPos(block.from, 1, MapMode.TrackAfter);
        const outputFrom = transaction.changes.mapPos(output.from, 1, MapMode.TrackAfter);
        const outputTo = transaction.changes.mapPos(output.to, -1, MapMode.TrackBefore);
        if (from !== null && blocks.some((candidate) =>
          candidate.from === from && candidate.terminal?.output?.from === outputFrom &&
          candidate.terminal.output.to === outputTo && candidate.terminal.output.fold === output.fold &&
          candidate.terminal.output.previewLines === output.previewLines)) mappedOutputs.set(from, open);
      }
      if (bulkAction === 'reset-folds') mappedOutputs.clear();
      else if (bulkAction) {
        const outputOverride = noteOutputOverride(bulkAction);
        if (outputOverride) {
          for (const block of blocks) {
            if (block.terminal?.output) mappedOutputs.set(block.from, outputOverride);
          }
        }
      }
      const outputs = outputStates(blocks, settings, transaction.state, mappedOutputs);
      const mappedAnsiEditing = new Set<number>();
      for (const from of previous.ansiEditing) {
        const mapped = transaction.changes.mapPos(from, 1, MapMode.TrackAfter);
        if (mapped !== null) mappedAnsiEditing.add(mapped);
      }
      for (const effect of transaction.effects) {
        if (effect.is(changeCommandWrap)) {
          commandWraps.set(effect.value.from, effect.value.wrap);
          continue;
        }
        if (effect.is(changeOutput)) {
          const output = outputs.get(effect.value.from);
          const block = blocks.find((candidate) => candidate.from === effect.value.from)?.terminal?.output;
          if (output && block) outputs.set(effect.value.from, effect.value.action === 'expand'
            ? { open: true, fullyExpanded: true } : nextOutputState(block, output));
          continue;
        }
        if (!effect.is(toggleFold)) continue;
        mappedAnsiEditing.delete(effect.value);
        const block = visibleBlocks.find((block) => block.from === effect.value);
        if (!block) continue;
        const next = nextFoldState(block, settings, folds.get(effect.value) ?? 'expanded');
        if (next === 'expanded') folds.delete(effect.value);
        else folds.set(effect.value, next);
        overrides.set(effect.value, next);
      }
      const ansiEditing = editingAnsiBlocks(blocks, settings, transaction.state, mappedAnsiEditing);
      return {
        livePreview, blocks, folds, overrides, outputs, ansiEditing, commandWraps,
        ...decorate(blocks, settings, folds, transaction.state, outputs, ansiEditing, commandWraps, remove),
      };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      // Keep the scroll container outside syntax marks, including in older CodeMirror hosts.
      Prec.lowest((EditorView.outerDecorations ?? EditorView.decorations).from(field, (value) => value.commandScrolls)),
    ],
  });
  function remove(view: EditorView, commandFrom: number, scope: 'block' | 'output'): void {
    const state = view.state;
    const { blocks, livePreview } = state.field(field);
    const command = blocks.find((block) => block.from === commandFrom && block.terminal);
    const output = command?.terminal?.output;
    const first = scope === 'output' ? output : command;
    const last = output ?? first;
    if (!livePreview || state.readOnly || !first || !last || first.unclosed || last.unclosed) {
      new Notice('Motto Code Block: This terminal block is no longer available for deletion.');
      return;
    }
    let from = first.from;
    const followingLine = last.endLine + 2;
    const next = followingLine <= state.doc.lines ? state.doc.line(followingLine) : undefined;
    const to = next?.from ?? state.doc.length;
    if (!next && from > 0) from--;
    let insert = '';
    if (next && blocks.some((block) => block.from === next.from && block.commandFrom === undefined)) {
      const joined = state.doc.sliceString(0, from) + state.doc.sliceString(to);
      const following = parseCodeBlocks(joined, getSettings()).blocks.find((block) => block.from === from);
      // Do not turn a previously unrelated fence into the preceding command's output.
      if (following?.commandFrom !== undefined) {
        const quotePrefix = /^[ \t]*(?:>[ \t]*)+/.exec(next.text)?.[0].trimEnd() ?? '';
        insert = quotePrefix + state.lineBreak;
      }
    }
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from }, userEvent: 'motto.delete-block' });
    view.focus();
  }
  return {
    extension: [
      field,
      Prec.high(EditorView.domEventHandlers({ paste: (event, view) => pasteAnsi(event, view, getSettings()) })),
      Prec.high(keymap.of([{
        key: 'Mod-a',
        run(view) {
          const { state } = view;
          const { livePreview, blocks } = state.field(field);
          if (!livePreview || state.selection.ranges.length !== 1) return false;
          const selection = state.selection.main;
          for (const block of blocks) {
            if (block.lineCount === 0) continue;
            const from = state.doc.line(block.startLine + 2).from;
            const to = state.doc.line(block.startLine + block.lineCount + 1).to;
            if (from === to || selection.from < from || selection.to > to) continue;
            if (selection.from === from && selection.to === to) return false;
            view.dispatch({ selection: { anchor: from, head: to }, userEvent: 'select' });
            return true;
          }
          return false;
        },
      }])),
      ViewPlugin.define((view) => {
        views.add(view);
        const place = () => {
          if (view.state.field(field).livePreview) measureDeleteButtonPlacement(view);
        };
        view.scrollDOM.addEventListener('scroll', place, { passive: true });
        place();
        return {
          update(update) {
            if (update.geometryChanged || update.viewportChanged || update.docChanged ||
                update.startState.field(field).decorations !== update.state.field(field).decorations) place();
          },
          destroy() {
            view.scrollDOM.removeEventListener('scroll', place);
            views.delete(view);
          },
        };
      }),
    ],
    refresh: () => {
      for (const view of views) view.dispatch({ effects: refresh.of(null) });
    },
    setNoteFolds: (editor, action, checking) => {
      const view = [...views].find((candidate) => candidate.state.field(editorInfoField, false)?.editor === editor);
      if (!view) return false;
      const { state } = view;
      const { livePreview, blocks } = state.field(field);
      if (!livePreview) return false;
      if (!checking) {
        const settings = getSettings();
        const affected = blocks.find((block) => {
          const fold = noteFoldOverride(block, settings, action) ??
            (action === 'reset-folds' ? resolveFoldState(block, settings) : 'expanded');
          if (hasFoldableHeader(block, settings) && hiddenBodyContainsSelection(block, settings, state, fold)) return true;
          const output = block.terminal?.output;
          if (!settings.commandBlocks || !output || !insideOutput(output, state)) return false;
          if (action === 'close-outputs') return true;
          if (action !== 'reset-folds') return false;
          const defaults = initialOutputState(output);
          return !defaults.open || outputPreviewLineCount(output, defaults) !== undefined;
        });
        view.dispatch({
          effects: changeNoteFolds.of(action),
          ...(affected ? { selection: { anchor: affected.from }, scrollIntoView: true } : {}),
        });
      }
      return true;
    },
  };
}
