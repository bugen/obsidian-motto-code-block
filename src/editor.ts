import { EditorSelection, MapMode, Prec, StateEffect, StateField, Text, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { editorInfoField, editorLivePreviewField, Notice, type Editor } from 'obsidian';
import { encodeAnsiSource, hasAnsiControls } from './ansi-text';
import { isCodeBlockEnabled, isHippoBlock, parseCodeBlocks, reportDiagnostics, updatePromptDisplayInfo, type CodeBlock, type HippoFarmOptions } from './codeblock';
import { applyHeaderStyles, copyCode, createExpandFooter, createHeader, setHeaderFoldState } from './render';
import { shouldShowHeader, type FoldState, type MottoSettings } from './settings';
import { createLineNumber, lineNumberWidth, shouldShowLineNumbers } from './line-numbers';
import { hasFoldableHeader, initialOutputState, nextFoldState, nextOutputState, noteFoldOverride, noteOutputOverride, outputPreviewLineCount, previewLineCount, resolveFoldState, type NoteFoldAction, type OutputState } from './folding';
import { formatCommandPrompt, splitCommands, type CommandPrompt, type CommandRange } from './commands';
import { ansiPreview, commandOutputPreview, commandPrompt, commandTools, inlinePromptColorClasses, outputToggleClasses, setOutputToggle, terminalDeleteButton, terminalEditButton } from './command-render';
import { destroyHippoSpeech } from './hippo-speech';
import { HippoBlockView } from './hippo-block';
import { sameFarm } from './hippo-farm';
import { createEl } from './dom';
import { forcesPromptHeader, SessionMenu, withSessionPrompt, type SessionMenuActions, type SessionOutputAction, type SessionPromptMode } from './session-menu';

interface HeaderState {
  livePreview: boolean;
  blocks: CodeBlock[];
  folds: Map<number, FoldState>;
  overrides: Map<number, FoldState>;
  outputs: Map<number, OutputState>;
  pendingOutputResets: Set<number>;
  sessionPrompts: Map<number, SessionPromptMode>;
  ansiEditing: Set<number>;
  commandWraps: Map<number, boolean>;
  decorations: DecorationSet;
  commandScrolls: DecorationSet;
}

const toggleFold = StateEffect.define<number>();
const changeOutput = StateEffect.define<{ from: number; action: 'toggle' | 'expand' }>();
const changeCommandWrap = StateEffect.define<{ from: number; wrap: boolean }>();
const changeNoteFolds = StateEffect.define<NoteFoldAction>();
const changeSessionOutputs = StateEffect.define<{ from: number; action: SessionOutputAction }>();
const changeSessionPrompt = StateEffect.define<{ from: number; mode: SessionPromptMode | null }>();

type DeleteTerminalBlock = (view: EditorView, commandFrom: number, scope: 'block' | 'output') => void;
type DeleteBlock = (view: EditorView, from: number, scope: 'block' | 'output' | 'hippo') => void;
type GetSessionActions = (view: EditorView, from: number) => SessionMenuActions | undefined;
const deleteBlockLabel = 'Delete command block and its output';
const applyPromptEvent = 'motto.apply-session-prompt';
const editorSessionMenus = new WeakMap<HTMLElement, { menu: SessionMenu; controls: HTMLElement }>();

function mountSessionMenu(
  host: HTMLElement, controls: HTMLElement, view: EditorView, from: number, getActions: GetSessionActions,
): void {
  const menu = new SessionMenu(host.ownerDocument, () => getActions(view, from), () => {
    view.contentDOM.querySelector<HTMLButtonElement>(`[data-motto-session-from="${from}"] .motto-session-menu`)
      ?.focus({ preventScroll: true });
  });
  host.dataset.mottoSessionFrom = String(from);
  menu.mount(controls);
  editorSessionMenus.set(host, { menu, controls });
}

function measureTerminalControls(view: EditorView): void {
  view.requestMeasure({
    key: measureTerminalControls,
    read: ({ contentDOM, scrollDOM }) => {
      const hosts = [...contentDOM.querySelectorAll<HTMLElement>('[data-motto-session-from]')];
      const frame = scrollDOM.getBoundingClientRect();
      const gutter = scrollDOM.querySelector('.cm-gutters')?.getBoundingClientRect();
      const left = Math.max(0, frame.left + scrollDOM.clientLeft,
        gutter && gutter.left < contentDOM.getBoundingClientRect().left ? gutter.right : 0);
      const deletions = [...contentDOM.querySelectorAll<HTMLButtonElement>(
        '.motto-command-delete-anchor > button.motto-terminal-delete',
      )].map((button) => {
        const anchor = button.parentElement!.getBoundingClientRect();
        return { button, outside: anchor.width > 0 && anchor.left - left >= 30 };
      });
      return { hosts, deletions };
    },
    write: ({ hosts, deletions }) => {
      for (const { button, outside } of deletions) button.classList.toggle('motto-delete-outside', outside);
      for (const host of hosts) {
        const mounted = editorSessionMenus.get(host);
        if (mounted && host.isConnected) {
          mounted.menu.attach(host.closest<HTMLElement>('.motto-command-menu-line') ?? host, mounted.controls, host);
        }
      }
    },
  });
}

function destroySessionMenu(host: HTMLElement): void {
  editorSessionMenus.get(host)?.menu.destroy();
  editorSessionMenus.delete(host);
}

function preserveScroll(view: EditorView, effect: StateEffect<unknown>): StateEffect<unknown>[] {
  // Keep the viewport from following the document bottom when a block changes height.
  return typeof view.scrollSnapshot === 'function' ? [effect, view.scrollSnapshot()] : [effect];
}

function dispatchFoldClick(view: EditorView, from: number, effect: StateEffect<unknown>): void {
  view.dispatch({ effects: preserveScroll(view, effect), selection: { anchor: from } });
}

class HeaderWidget extends WidgetType {
  readonly block: CodeBlock;
  readonly settings: MottoSettings;
  readonly foldState: FoldState;
  private readonly remove: DeleteTerminalBlock | undefined;
  private readonly menu: GetSessionActions | undefined;
  private readonly forceHeader: boolean;

  constructor(
    block: CodeBlock, settings: MottoSettings, foldState: FoldState, remove?: DeleteTerminalBlock,
    menu?: GetSessionActions, forceHeader = false,
  ) {
    super();
    this.block = block;
    this.settings = settings;
    this.foldState = foldState;
    this.remove = remove;
    this.menu = menu;
    this.forceHeader = forceHeader;
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
      this.menu === other.menu && (!this.menu || this.block.from === other.block.from) && this.forceHeader === other.forceHeader &&
      hasFoldableHeader(this.block, this.settings) === hasFoldableHeader(other.block, other.settings) &&
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
    const header = createHeader(view.dom.ownerDocument, this.block,
      this.forceHeader ? { ...this.settings, headerDisplay: 'always' } : this.settings,
      hasFoldableHeader(this.block, this.settings) ? {
        state: this.foldState,
        toggle: (header) => {
          const from = view.posAtDOM(header);
          dispatchFoldClick(view, from, toggleFold.of(from));
        },
      } : undefined);
    if (!header) throw new Error('[Motto Code Block] Cannot mount a disabled header.');
    const remove = this.remove;
    if (remove) {
      header.classList.add('motto-command-delete-anchor');
      header.prepend(terminalDeleteButton(view.dom.ownerDocument,
        deleteBlockLabel, () => { remove(view, view.posAtDOM(header), 'block'); }));
    }
    if (this.menu) mountSessionMenu(header, header.querySelector<HTMLElement>('.motto-header-controls')!, view,
      this.block.from, this.menu);
    return header;
  }

  override destroy(header: HTMLElement): void { destroySessionMenu(header); }
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

function promptWidthProperty(from: number): string {
  return `--motto-inline-prompt-width-${from}`;
}

function commandPromptStyle(prompt: CommandPrompt, from: number): string {
  return prompt.inlineContext ? `--motto-command-prompt-width: var(${promptWidthProperty(from)});` : '';
}

function promptRuler(document: Document, prompt: CommandPrompt, from: number): HTMLElement {
  const clip = createEl(document, 'span');
  clip.className = 'motto-command-prompt-ruler';
  clip.setAttribute('aria-hidden', 'true');
  const ruler = clip.createSpan();
  ruler.dataset.mottoPromptWidth = promptWidthProperty(from);
  ruler.dataset.context = prompt.inlineContext;
  ruler.dataset.symbol = prompt.symbol;
  return clip;
}

class PromptRulerWidget extends WidgetType {
  private readonly prompt: CommandPrompt;
  private readonly from: number;

  constructor(prompt: CommandPrompt, from: number) {
    super();
    this.prompt = prompt;
    this.from = from;
  }

  override eq(other: PromptRulerWidget): boolean {
    return this.from === other.from && this.prompt.inlineContext === other.prompt.inlineContext &&
      this.prompt.symbol === other.prompt.symbol;
  }

  override toDOM(view: EditorView): HTMLElement {
    return promptRuler(view.dom.ownerDocument, this.prompt, this.from);
  }
}

function observePromptWidths(view: EditorView): { measure(): void; destroy(): void } {
  const win = view.dom.ownerDocument.defaultView;
  const style = view.scrollDOM.style;
  const observed = new Set<HTMLElement>();
  const applied = new Map<string, number>();
  const resize = new ResizeObserver(() => measure());
  function measure(): void {
    view.requestMeasure({
      key: measure,
      read: () => {
        const rulers = new Set(view.contentDOM.querySelectorAll<HTMLElement>('[data-motto-prompt-width]'));
        const widths = new Map<string, number>();
        for (const ruler of rulers) {
          const property = ruler.dataset.mottoPromptWidth!;
          const width = Number.parseFloat(win?.getComputedStyle(ruler).width ?? '');
          // Reserve the entire intrinsic width, including fractional glyph advances.
          if (width > 0) widths.set(property, Math.max(Math.ceil(width), widths.get(property) ?? 0));
        }
        return { rulers, widths };
      },
      write: ({ rulers, widths }) => {
        for (const ruler of observed) {
          if (rulers.has(ruler)) continue;
          resize.unobserve(ruler);
          observed.delete(ruler);
        }
        for (const ruler of rulers) {
          if (observed.has(ruler)) continue;
          resize.observe(ruler);
          observed.add(ruler);
        }
        for (const property of applied.keys()) {
          if (widths.has(property)) continue;
          style.removeProperty(property);
          applied.delete(property);
        }
        for (const [property, width] of widths) {
          if (applied.get(property) === width) continue;
          style.setProperty(property, `${width}px`);
          applied.set(property, width);
        }
      },
    });
  }
  return {
    measure,
    destroy() {
      resize.disconnect();
      for (const property of applied.keys()) style.removeProperty(property);
    },
  };
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
  private readonly menu: GetSessionActions | undefined;

  constructor(
    from: number, text: string | null, prompt: CommandPrompt, output: boolean, open: boolean, partial: boolean,
    styles: MottoSettings['outputToggleStyles'], tapMyHippo: boolean, emptyControls?: EmptyCommandControls,
    menu?: GetSessionActions,
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
    this.menu = menu;
  }

  private sameContent(other: CommandWidget): boolean {
    const parts = this.prompt.inlineParts;
    const otherParts = other.prompt.inlineParts;
    return this.from === other.from && this.text === other.text &&
      this.prompt.symbol === other.prompt.symbol && this.prompt.inlineContext === other.prompt.inlineContext &&
      parts?.length === otherParts?.length &&
      (!parts || parts.every((part, i) => part.field === otherParts?.[i]?.field && part.text === otherParts?.[i]?.text)) &&
      this.prompt.tooltip === other.prompt.tooltip &&
      this.output === other.output && this.emptyControls?.editAt === other.emptyControls?.editAt &&
      this.emptyControls?.remove === other.emptyControls?.remove &&
      Boolean(this.emptyControls) === Boolean(other.emptyControls) && this.menu === other.menu;
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
    } else if (this.emptyControls) {
      marker.append(commandPrompt(document, this.prompt));
    }
    const tools = commandTools(document, this.emptyControls ? '' : this.text, this.open, this.styles, this.output ? () => {
      dispatchFoldClick(view, this.from, changeOutput.of({ from: this.from, action: 'toggle' }));
    } : undefined, this.tapMyHippo, this.partial);
    marker.append(tools);
    if (!this.emptyControls) {
      if (this.menu) mountSessionMenu(marker, tools, view, this.from, this.menu);
      return marker;
    }

    const row = createEl(document, 'div');
    row.className = 'motto-command-line motto-command-empty-line';
    row.contentEditable = 'false';
    row.style.cssText = commandPromptStyle(this.prompt, this.from);
    row.append(marker);
    if (this.prompt.inlineContext) row.append(promptRuler(document, this.prompt, this.from));
    const { editAt, remove } = this.emptyControls;
    if (editAt !== undefined) tools.prepend(terminalEditButton(document, 'Edit command source', () => {
      view.dispatch({ selection: { anchor: editAt } });
      view.focus();
    }));
    if (remove) {
      row.classList.add('motto-command-delete-anchor');
      row.append(terminalDeleteButton(document, deleteBlockLabel, () => { remove(view, this.from, 'block'); }));
    }
    if (this.menu) mountSessionMenu(row, tools, view, this.from, this.menu);
    return row;
  }

  override destroy(marker: HTMLElement): void {
    destroySessionMenu(marker);
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
    const document = view.dom.ownerDocument;
    const remove = this.remove;
    const preview = commandOutputPreview(document, this.block, this.preview, () => {
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

class HippoWidget extends WidgetType {
  private static readonly views = new WeakMap<HTMLElement, HippoBlockView>();
  private readonly speak: boolean;
  private readonly farm: HippoFarmOptions | undefined;
  private readonly remove: DeleteBlock | undefined;

  constructor(speak: boolean, farm?: HippoFarmOptions, remove?: DeleteBlock) {
    super();
    this.speak = speak;
    this.farm = farm;
    this.remove = remove;
  }

  override eq(other: HippoWidget): boolean {
    return this.speak === other.speak && this.remove === other.remove && sameFarm(this.farm, other.farm);
  }

  override updateDOM(element: HTMLElement, _view: EditorView, previous: HippoWidget): boolean {
    if (this.remove !== previous.remove || !sameFarm(this.farm, previous.farm)) return false;
    const preview = HippoWidget.views.get(element);
    if (!preview) return false;
    preview.setSpeech(this.speak);
    return true;
  }

  override toDOM(view: EditorView): HTMLElement {
    const remove = this.remove;
    const preview = new HippoBlockView(view.dom.ownerDocument, this.farm, remove ? {
      edit: () => {
        view.dispatch({ selection: { anchor: view.posAtDOM(preview.element) }, scrollIntoView: true });
        view.focus();
      },
      remove: () => { remove(view, view.posAtDOM(preview.element), 'hippo'); },
    } : undefined);
    preview.setSpeech(this.speak);
    HippoWidget.views.set(preview.element, preview);
    return preview.element;
  }

  override destroy(element: HTMLElement): void {
    HippoWidget.views.get(element)?.dispose();
    HippoWidget.views.delete(element);
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

function sessionMembers(blocks: CodeBlock[], from: number): CodeBlock[] {
  return blocks.filter((block) => block.terminal?.sessionFrom === from);
}

function insideOutput(block: CodeBlock, state: EditorState, from = block.from): boolean {
  return state.selection.ranges.some(({ anchor, head }) =>
    (anchor >= from && anchor <= block.to) || (head >= from && head <= block.to));
}

function hidesEditingOutput(block: CodeBlock, state: EditorState, action: SessionOutputAction): boolean {
  const output = block.terminal?.output;
  if (!output || !insideOutput(output, state)) return false;
  if (action === 'close-outputs') return true;
  if (action !== 'reset-outputs') return false;
  const defaults = initialOutputState(output);
  return !defaults.open || outputPreviewLineCount(output, defaults) !== undefined;
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
  pendingResets = new Set<number>(),
): Map<number, OutputState> {
  const outputs = new Map<number, OutputState>();
  if (!settings.commandBlocks) return outputs;
  for (const block of blocks) {
    const output = block.terminal?.output;
    if (output) outputs.set(block.from, !pendingResets.has(block.from) && insideOutput(output, state)
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
  sessionPrompts: Map<number, SessionPromptMode>, remove: DeleteBlock, getSessionActions: GetSessionActions,
): Pick<HeaderState, 'decorations' | 'commandScrolls'> {
  const decorations: Range<Decoration>[] = [];
  const commandScrolls: Range<Decoration>[] = [];
  for (const block of blocks) {
    if (isHippoBlock(block)) {
      if (state.readOnly || !insideOutput(block, state)) {
        decorations.push(Decoration.replace({
          block: true, widget: new HippoWidget(settings.tapMyHippo, block.hippoFarm, state.readOnly ? undefined : remove),
        }).range(block.from, block.to));
      }
      continue;
    }
    if (settings.commandBlocks && block.commandFrom !== undefined) continue;
    const foldState = folds.get(block.from) ?? 'expanded';
    const terminal = settings.commandBlocks ? block.terminal : undefined;
    const menu = terminal?.session === 'first' ? getSessionActions : undefined;
    const promptMode = terminal ? sessionPrompts.get(block.from) : undefined;
    const display = withSessionPrompt(block, promptMode);
    const forceHeader = forcesPromptHeader(block, promptMode);
    const canRemoveBlock = terminal && !state.readOnly && !block.unclosed && !terminal.output?.unclosed;
    const preview = foldState === 'partial' ? previewLineCount(block, settings) : undefined;
    const hasHeader = forceHeader || shouldShowHeader(settings.headerDisplay, block.hasParameters);
    if (hasHeader) {
      decorations.push(Decoration.widget({
        widget: new HeaderWidget(display, settings, foldState,
          canRemoveBlock && foldState === 'folded' ? remove : undefined, foldState === 'folded' ? menu : undefined, forceHeader),
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
      const prompt = formatCommandPrompt(block.language, display.terminal);
      const output = terminal.output;
      const outputState = outputs.get(block.from);
      const editingOutput = output !== undefined && insideOutput(output, state);
      const open = editingOutput || outputState?.open === true;
      const outputPreview = output && outputState && !editingOutput ? outputPreviewLineCount(output, outputState) : undefined;
      const partialOutput = open && outputPreview !== undefined;
      const count = preview ?? block.lineCount;
      const emptyPreview = output !== undefined && commands.length === 0 &&
        !insideOutput(block, state, block.from + 1);
      const first = commands[0];
      const firstVisible = first !== undefined && first.startLine < count;
      if (emptyPreview) {
        // Exclude the opening boundary so toggling the output does not reveal the empty command's fences.
        const editAt = block.lineCount === 0 ? state.doc.line(block.startLine + 1).to : bodyStart(block, state);
        decorations.push(Decoration.replace({
          block: true, widget: new CommandWidget(block.from, null, prompt, true, open, partialOutput,
            settings.outputToggleStyles, settings.tapMyHippo, {
              ...(!state.readOnly ? { editAt } : {}),
              ...(canRemoveBlock ? { remove } : {}),
            }, menu),
        }).range(block.from, block.to));
      } else {
        if (canRemoveBlock) {
          const anchor = firstVisible ? state.doc.line(block.startLine + first.startLine + 2).from : block.from;
          decorations.push(Decoration.line({ class: 'motto-command-delete-anchor' }).range(anchor));
          decorations.push(Decoration.widget({ widget: new DeleteCommandWidget(block.from, remove), side: -1 }).range(anchor));
        }
        if (menu && !firstVisible) {
          decorations.push(Decoration.line({ class: 'motto-command-menu-line motto-command-menu-fence' }).range(block.from));
          decorations.push(Decoration.widget({
            widget: new CommandWidget(block.from, null, prompt, false, false, false,
              settings.outputToggleStyles, settings.tapMyHippo, undefined, menu),
            side: -1,
          }).range(block.from));
        }
      }
      const promptWidth = commandPromptStyle(prompt, block.from);
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
            (menu && first?.startLine === line ? ' motto-command-menu-line' : '') +
            (withToggle ? ` ${outputToggleClasses(settings.outputToggleStyles)}` : ''),
          style: `${promptWidth}--motto-command-tools-width: ${withToggle ? '68px' : '36px'}`,
        } }).range(from));
        if (prompt.inlineContext && !emptyPreview) {
          decorations.push(Decoration.widget({
            widget: new PromptRulerWidget(prompt, block.from), side: -2,
          }).range(from));
        }
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
            settings.outputToggleStyles, settings.tapMyHippo, undefined, index === 0 ? menu : undefined),
          side: -1,
        }).range(state.doc.line(block.startLine + command.startLine + 2).from));
      }
      if (output) {
        if (!open || preview !== undefined) {
          decorations.push(Decoration.replace({ block: true }).range(output.from, output.to));
        } else if (editingOutput) {
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
      const sessionPrompts = new Map<number, SessionPromptMode>();
      return {
        livePreview, blocks, folds, overrides, outputs, pendingOutputResets: new Set(), sessionPrompts, ansiEditing, commandWraps,
        ...decorate(blocks, settings, folds, state, outputs, ansiEditing, commandWraps, sessionPrompts, remove, getSessionActions),
      };
    },
    update(previous, transaction) {
      const livePreview = transaction.state.field(editorLivePreviewField, false) === true;
      const reparse = transaction.docChanged || livePreview !== previous.livePreview ||
        transaction.effects.some((effect) => effect.is(refresh));
      const bulkAction = transaction.effects.find((effect) => effect.is(changeNoteFolds))?.value;
      const sessionOutput = transaction.effects.find((effect) => effect.is(changeSessionOutputs))?.value;
      const sessionPrompt = transaction.effects.find((effect) => effect.is(changeSessionPrompt))?.value;
      if (!reparse && transaction.startState.readOnly === transaction.state.readOnly && !bulkAction && !sessionOutput && !sessionPrompt &&
        !transaction.effects.some((effect) =>
        effect.is(toggleFold) || effect.is(changeOutput) || effect.is(changeCommandWrap)) &&
          !(transaction.selection && (previous.folds.size > 0 || previous.outputs.size > 0 ||
            previous.blocks.some((block) => block.language === 'ansi' || isHippoBlock(block))))) return previous;
      const blocks = reparse ? readBlocks(livePreview, transaction.state.doc.toString()) : previous.blocks;
      const settings = getSettings();
      const byFrom = new Map(blocks.map((block) => [block.from, block]));
      const mapCommand = (block: CodeBlock) => {
        const from = transaction.changes.mapPos(block.from, 1, MapMode.TrackAfter);
        const candidate = from !== null ? byFrom.get(from) : undefined;
        if (candidate?.terminal) return candidate;
        // An opening fence can be replaced while its closing fence still identifies the same block.
        const start = transaction.changes.mapPos(block.from, -1);
        const end = transaction.changes.mapPos(block.to, -1, MapMode.TrackBefore);
        const edited = byFrom.get(start);
        return edited?.terminal && edited.to === end ? edited : undefined;
      };
      const sessionPrompts = new Map<number, SessionPromptMode>();
      if (previous.sessionPrompts.size > 0) {
        for (const block of previous.blocks) {
          const mode = previous.sessionPrompts.get(block.from);
          if (!mode) continue;
          const candidate = mapCommand(block);
          if (candidate) sessionPrompts.set(candidate.from, mode);
        }
      }
      if (sessionPrompt) {
        for (const block of sessionMembers(blocks, sessionPrompt.from)) {
          if (sessionPrompt.mode === null) sessionPrompts.delete(block.from);
          else sessionPrompts.set(block.from, sessionPrompt.mode);
        }
      }
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
      const outputMembers = sessionOutput ? sessionMembers(blocks, sessionOutput.from) : [];
      if (sessionOutput?.action === 'open-outputs') {
        for (const block of outputMembers) {
          const override = noteFoldOverride(block, settings, sessionOutput.action);
          if (override) overrides.set(block.from, override);
        }
      }
      const folds = foldedBlocks(visibleBlocks, settings, transaction.state, overrides);
      const mappedOutputs = new Map<number, OutputState>();
      const pendingOutputResets = new Set<number>();
      const compareSource = transaction.docChanged && !transaction.isUserEvent(applyPromptEvent);
      const changed = (before: CodeBlock, after: CodeBlock) => compareSource &&
        transaction.changes.touchesRange(before.from, before.to) &&
        transaction.startState.doc.sliceString(before.from, before.to) !== transaction.state.doc.sliceString(after.from, after.to);
      for (const block of previous.blocks) {
        const output = block.terminal?.output;
        const open = previous.outputs.get(block.from);
        if (!output || open === undefined) continue;
        const candidate = mapCommand(block);
        const nextOutput = candidate?.terminal?.output;
        if (!candidate || !nextOutput) continue;
        const sameOutput = nextOutput.from === transaction.changes.mapPos(output.from, 1, MapMode.TrackAfter) &&
          nextOutput.to === transaction.changes.mapPos(output.to, -1, MapMode.TrackBefore);
        const reset = !sameOutput || changed(block, candidate) || changed(output, nextOutput) ||
          nextOutput.fold !== output.fold || nextOutput.previewLines !== output.previewLines;
        if (!reset) mappedOutputs.set(candidate.from, open);
        // Keep the source visible while editing without saving the forced-open state over the reset.
        if ((reset || previous.pendingOutputResets.has(block.from)) && insideOutput(nextOutput, transaction.state)) {
          pendingOutputResets.add(candidate.from);
        }
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
      if (sessionOutput) {
        for (const block of outputMembers) {
          const output = block.terminal?.output;
          if (output) mappedOutputs.set(block.from, sessionOutput.action === 'reset-outputs'
            ? initialOutputState(output) : noteOutputOverride(sessionOutput.action));
          pendingOutputResets.delete(block.from);
        }
      }
      const outputs = outputStates(blocks, settings, transaction.state, mappedOutputs, pendingOutputResets);
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
        livePreview, blocks, folds, overrides, outputs, pendingOutputResets, sessionPrompts, ansiEditing, commandWraps,
        ...decorate(blocks, settings, folds, transaction.state, outputs, ansiEditing, commandWraps, sessionPrompts, remove, getSessionActions),
      };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      // Keep the scroll container outside syntax marks, including in older CodeMirror hosts.
      Prec.lowest((EditorView.outerDecorations ?? EditorView.decorations).from(field, (value) => value.commandScrolls)),
    ],
  });
  function getSessionActions(view: EditorView, from: number): SessionMenuActions | undefined {
    const snapshot = view.state.doc;
    const { blocks } = view.state.field(field);
    const members = sessionMembers(blocks, from);
    if (members.length === 0) return;
    const commands = members.flatMap((block) =>
      splitCommands(block.text, block.language).map((range) => block.text.slice(range.from, range.to)));
    const run = (action: () => void) => {
      const current = sessionMembers(view.state.field(field).blocks, from);
      if (view.state.doc !== snapshot || current.length !== members.length ||
        members.some((block, index) => block.from !== current[index]?.from)) {
        new Notice('Motto Code Block: This terminal session has changed. Reopen its menu and try again.');
        return;
      }
      action();
    };
    const writePrompt = (mode: SessionPromptMode) => run(() => {
      if (view.state.readOnly) {
        new Notice('Motto Code Block: This note is read-only.');
        return;
      }
      const changes: { from: number; to: number; insert: string }[] = [];
      for (const block of members) {
        const range = block.infoRange;
        const info = range && snapshot.sliceString(range.from, range.to);
        const updated = info === undefined ? undefined : updatePromptDisplayInfo(info, mode);
        if (!range || updated === undefined) {
          new Notice('Motto Code Block: Could not update the terminal session. Check its opening fences.');
          return;
        }
        if (updated !== info) changes.push({ ...range, insert: updated });
      }
      view.dispatch({
        changes,
        effects: preserveScroll(view, changeSessionPrompt.of({ from, mode: null })),
        userEvent: applyPromptEvent,
      });
    });
    return {
      hasOutputs: members.some((block) => block.terminal?.output),
      hasCommands: commands.length > 0,
      changeOutputs: (action) => run(() => {
        const affected = members.find((block) => hidesEditingOutput(block, view.state, action));
        view.dispatch({
          effects: preserveScroll(view, changeSessionOutputs.of({ from, action })),
          ...(affected ? { selection: { anchor: affected.from } } : {}),
        });
      }),
      changePrompt: (mode) => run(() => {
        view.dispatch({ effects: preserveScroll(view, changeSessionPrompt.of({ from, mode })) });
      }),
      ...(!view.state.readOnly ? { writePrompt } : {}),
      copyCommands: () => run(() => { void copyCode(view.dom.ownerDocument, commands.join('\n')); }),
    };
  }

  const remove: DeleteBlock = (view, blockFrom, scope) => {
    const state = view.state;
    const { blocks, livePreview } = state.field(field);
    const block = blocks.find((block) => block.from === blockFrom && (scope === 'hippo' ? isHippoBlock(block) : block.terminal));
    const output = block?.terminal?.output;
    const first = scope === 'output' ? output : block;
    const last = output ?? first;
    if (!livePreview || state.readOnly || !first || !last || first.unclosed || last.unclosed) {
      const kind = scope === 'hippo' ? 'Hippo' : 'terminal';
      new Notice(`Motto Code Block: This ${kind} block is no longer available for deletion.`);
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
  };
  return {
    extension: [
      field,
      EditorView.editorAttributes.of(() => ({ class: inlinePromptColorClasses(getSettings().colorInlinePrompts).join(' ') })),
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
        const promptWidths = observePromptWidths(view);
        const place = () => {
          if (view.state.field(field).livePreview) measureTerminalControls(view);
        };
        view.scrollDOM.addEventListener('scroll', place, { passive: true });
        place();
        if (view.state.field(field).livePreview) promptWidths.measure();
        return {
          update(update) {
            if (update.geometryChanged || update.viewportChanged || update.docChanged ||
                update.startState.field(field).decorations !== update.state.field(field).decorations) {
              place();
              if (update.startState.field(field).livePreview || update.state.field(field).livePreview) promptWidths.measure();
            }
          },
          destroy() {
            view.scrollDOM.removeEventListener('scroll', place);
            promptWidths.destroy();
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
          return settings.commandBlocks && (action === 'close-outputs' || action === 'reset-folds') &&
            hidesEditingOutput(block, state, action === 'reset-folds' ? 'reset-outputs' : action);
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
