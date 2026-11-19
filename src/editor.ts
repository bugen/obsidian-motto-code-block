import { MapMode, Prec, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import { parseCodeBlocks, reportDiagnostics, type CodeBlock } from './codeblock';
import { applyHeaderStyles, createExpandFooter, createHeader, setHeaderFoldState } from './render';
import { isLanguageEnabled, shouldShowHeader, type FoldState, type MottoSettings } from './settings';
import { createLineNumber, lineNumberWidth, shouldShowLineNumbers } from './line-numbers';
import { initialOutputState, nextFoldState, nextOutputState, outputPreviewLineCount, previewLineCount, resolveFoldState, type OutputState } from './folding';
import { splitCommands } from './commands';
import { ansiPreview, commandOutputPreview, commandTools, outputToggleClasses, setOutputToggle } from './command-render';
import { destroyHippoSpeech } from './hippo-speech';
import { createEl } from './dom';

interface HeaderState {
  livePreview: boolean;
  blocks: CodeBlock[];
  folds: Map<number, FoldState>;
  overrides: Map<number, FoldState>;
  outputs: Map<number, OutputState>;
  ansiEditing: Set<number>;
  decorations: DecorationSet;
}

const toggleFold = StateEffect.define<number>();
const changeOutput = StateEffect.define<{ from: number; action: 'toggle' | 'expand' }>();

class HeaderWidget extends WidgetType {
  readonly block: CodeBlock;
  readonly settings: MottoSettings;
  readonly foldState: FoldState;

  constructor(block: CodeBlock, settings: MottoSettings, foldState: FoldState) {
    super();
    this.block = block;
    this.settings = settings;
    this.foldState = foldState;
  }

  private sameContent(other: HeaderWidget): boolean {
    return this.block.title === other.block.title && this.block.language === other.block.language &&
      this.block.text === other.block.text &&
      this.block.headerStyle === other.block.headerStyle &&
      this.block.terminal?.user === other.block.terminal?.user &&
      this.block.terminal?.host === other.block.terminal?.host &&
      this.block.terminal?.cwd === other.block.terminal?.cwd &&
      Boolean(this.block.terminal) === Boolean(other.block.terminal) &&
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
        view.dispatch({ effects: toggleFold.of(from), selection: { anchor: from } });
      },
    });
    if (!header) throw new Error('[Motto Code Block] Cannot mount a disabled header.');
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
      view.dispatch({ effects: toggleFold.of(this.from), selection: { anchor: this.from } });
      view.focus();
    });
  }
}

class CommandWidget extends WidgetType {
  readonly from: number;
  readonly text: string | null;
  readonly prompt: string;
  readonly output: boolean;
  readonly open: boolean;
  readonly styles: MottoSettings['outputToggleStyles'];
  readonly tapMyHippo: boolean;

  constructor(
    from: number, text: string | null, prompt: string, output: boolean, open: boolean,
    styles: MottoSettings['outputToggleStyles'], tapMyHippo: boolean,
  ) {
    super();
    this.from = from;
    this.text = text;
    this.prompt = prompt;
    this.output = output;
    this.open = open;
    this.styles = styles;
    this.tapMyHippo = tapMyHippo;
  }

  private sameContent(other: CommandWidget): boolean {
    return this.from === other.from && this.text === other.text && this.prompt === other.prompt &&
      this.output === other.output;
  }

  override eq(other: CommandWidget): boolean {
    return this.sameContent(other) && this.open === other.open && this.styles === other.styles &&
      this.tapMyHippo === other.tapMyHippo;
  }

  override updateDOM(marker: HTMLElement, _view: EditorView, previous: CommandWidget): boolean {
    if (!this.sameContent(previous)) return false;
    const button = marker.querySelector<HTMLButtonElement>('.motto-output-toggle');
    if (button) setOutputToggle(button, this.open, this.styles, this.tapMyHippo);
    return true;
  }

  override toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const marker = createEl(document, 'span');
    marker.className = this.text === null ? 'motto-command-empty-tools' : 'motto-command-marker';
    marker.contentEditable = 'false';
    if (this.text !== null) {
      const prompt = marker.createSpan();
      prompt.className = 'motto-command-prompt';
      prompt.setAttribute('aria-hidden', 'true');
      prompt.textContent = this.prompt;
    }
    marker.append(commandTools(document, this.text, this.open, this.styles, this.output ? () => {
      view.dispatch({ effects: changeOutput.of({ from: this.from, action: 'toggle' }), selection: { anchor: this.from } });
    } : undefined, this.tapMyHippo));
    return marker;
  }

  override destroy(marker: HTMLElement): void {
    destroyHippoSpeech(marker);
  }
}

class OutputWidget extends WidgetType {
  private static readonly previews = new WeakMap<HTMLElement, ReturnType<typeof commandOutputPreview>>();
  readonly commandFrom: number;
  readonly block: CodeBlock;
  readonly preview: number | undefined;

  constructor(commandFrom: number, block: CodeBlock, preview: number | undefined) {
    super();
    this.commandFrom = commandFrom;
    this.block = block;
    this.preview = preview;
  }

  override eq(other: OutputWidget): boolean {
    return this.commandFrom === other.commandFrom && this.block.from === other.block.from &&
      this.block.language === other.block.language &&
      this.block.startLine === other.block.startLine && this.block.text === other.block.text &&
      this.block.lineCount === other.block.lineCount && this.preview === other.preview;
  }

  override toDOM(view: EditorView): HTMLElement {
    const preview = commandOutputPreview(view.dom.ownerDocument, this.block, this.preview, () => {
      view.dispatch({
        effects: changeOutput.of({ from: this.commandFrom, action: 'expand' }),
        selection: { anchor: this.commandFrom },
      });
      view.focus();
    }, () => { editOutput(view, this.block); });
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
      this.settings.lineNumbers === other.settings.lineNumbers && this.preview === other.preview;
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
    if (block.language !== 'ansi' || (settings.commandBlocks && block.commandFrom !== undefined)) continue;
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

function foldedBlocks(
  blocks: CodeBlock[], settings: MottoSettings, state: EditorState, overrides: Map<number, FoldState>,
): Map<number, FoldState> {
  const folds = new Map<number, FoldState>();
  for (const block of blocks) {
    if (settings.commandBlocks && block.commandFrom !== undefined) continue;
    const foldState = resolveFoldState(block, settings, overrides.get(block.from));
    if (foldState === 'expanded') continue;
    const from = foldState === 'partial'
      ? state.doc.line(block.startLine + previewLineCount(block, settings) + 2).from : block.from + 1;
    const to = commandEnd(block, settings) +
      (foldState === 'partial' || block.language === 'ansi' ||
        (settings.commandBlocks && block.terminal?.output !== undefined) ? 1 : 0);
    if (state.selection.ranges.some(({ anchor, head }) =>
      (anchor >= from && anchor < to) || (head >= from && head < to))) {
      overrides.set(block.from, 'expanded');
    } else folds.set(block.from, foldState);
  }
  return folds;
}

function decorate(
  blocks: CodeBlock[], settings: MottoSettings, folds: Map<number, FoldState>, state: EditorState,
  outputs: Map<number, OutputState>, ansiEditing: Set<number>,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  for (const block of blocks) {
    if (settings.commandBlocks && block.commandFrom !== undefined) continue;
    const foldState = folds.get(block.from) ?? 'expanded';
    const preview = foldState === 'partial' ? previewLineCount(block, settings) : undefined;
    const hasHeader = shouldShowHeader(settings.headerDisplay, block.hasParameters);
    if (hasHeader) {
      decorations.push(Decoration.widget({
        widget: new HeaderWidget(block, settings, foldState), block: true, side: -1,
      }).range(block.from));
      decorations.push(foldState === 'folded'
        ? Decoration.replace({ block: true }).range(block.from, commandEnd(block, settings))
        : Decoration.line({ class: 'motto-code-block-start' }).range(block.from));
    }
    if (foldState === 'folded') continue;
    if (block.language === 'ansi' && !ansiEditing.has(block.from)) {
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
    if (settings.commandBlocks && block.terminal) {
      decorations.push(Decoration.line({ class: 'motto-command-start' }).range(block.from));
      const commands = splitCommands(block.text);
      const output = block.terminal.output;
      const outputState = outputs.get(block.from);
      const open = outputState?.open === true;
      const count = preview ?? block.lineCount;
      const lastCommand = commands[commands.length - 1];
      for (let line = 0; line < count; line++) {
        const withToggle = output !== undefined && lastCommand?.startLine === line && lastCommand.endLine < count;
        decorations.push(Decoration.line({ attributes: {
          class: `motto-command-line${withToggle ? ` ${outputToggleClasses(settings.outputToggleStyles)}` : ''}`,
          style: `--motto-command-tools-width: ${withToggle ? '68px' : '36px'}`,
        } }).range(state.doc.line(block.startLine + line + 2).from));
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
          widget: new CommandWidget(block.from, block.text.slice(command.from, command.to),
            block.terminal.user === 'root' ? '#' : '$',
            output !== undefined && index === commands.length - 1 && command.endLine < count, open,
            settings.outputToggleStyles, settings.tapMyHippo),
          side: -1,
        }).range(state.doc.line(block.startLine + command.startLine + 2).from));
      }
      if (output) {
        if (commands.length === 0) decorations.push(Decoration.widget({
          widget: new CommandWidget(block.from, null, '', true, open, settings.outputToggleStyles, settings.tapMyHippo),
          block: true, side: -1,
        }).range(output.from));
        if (!open || preview !== undefined) {
          decorations.push(Decoration.replace({ block: true }).range(output.from, output.to));
        } else if (insideOutput(output, state)) {
          for (let line = output.startLine; line <= output.endLine; line++) {
            decorations.push(Decoration.line({ class: 'motto-command-output-source' }).range(state.doc.line(line + 1).from));
          }
        } else decorations.push(Decoration.replace({
          block: true, widget: new OutputWidget(block.from, output,
            outputState ? outputPreviewLineCount(output, outputState) : undefined),
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
  return Decoration.set(decorations, true);
}

export function createEditorHeaders(getSettings: () => MottoSettings): { extension: Extension; refresh: () => void } {
  const refresh = StateEffect.define<null>();
  const views = new Set<EditorView>();
  function readBlocks(livePreview: boolean, source: string): CodeBlock[] {
    if (!livePreview) return [];
    const settings = getSettings();
    const result = parseCodeBlocks(source, (language) => isLanguageEnabled(language, settings), settings.outputLanguages);
    reportDiagnostics(result.diagnostics, 'editor');
    return result.blocks.filter((block) => !block.exclude && isLanguageEnabled(block.language, settings));
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
      return {
        livePreview, blocks, folds, overrides, outputs, ansiEditing,
        decorations: decorate(blocks, settings, folds, state, outputs, ansiEditing),
      };
    },
    update(previous, transaction) {
      const livePreview = transaction.state.field(editorLivePreviewField, false) === true;
      const reparse = transaction.docChanged || livePreview !== previous.livePreview ||
        transaction.effects.some((effect) => effect.is(refresh));
      if (!reparse && !transaction.effects.some((effect) => effect.is(toggleFold) || effect.is(changeOutput)) &&
          !(transaction.selection && (previous.folds.size > 0 || previous.outputs.size > 0 ||
            previous.blocks.some((block) => block.language === 'ansi')))) return previous;
      const blocks = reparse ? readBlocks(livePreview, transaction.state.doc.toString()) : previous.blocks;
      const settings = getSettings();
      const visibleBlocks = blocks.filter((block) =>
        !(settings.commandBlocks && block.commandFrom !== undefined) &&
        shouldShowHeader(settings.headerDisplay, block.hasParameters));
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
      const outputs = outputStates(blocks, settings, transaction.state, mappedOutputs);
      const mappedAnsiEditing = new Set<number>();
      for (const from of previous.ansiEditing) {
        const mapped = transaction.changes.mapPos(from, 1, MapMode.TrackAfter);
        if (mapped !== null) mappedAnsiEditing.add(mapped);
      }
      for (const effect of transaction.effects) {
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
        livePreview, blocks, folds, overrides, outputs, ansiEditing,
        decorations: decorate(blocks, settings, folds, transaction.state, outputs, ansiEditing),
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
  return {
    extension: [
      field,
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
        return { destroy: () => { views.delete(view); } };
      }),
    ],
    refresh: () => {
      for (const view of views) view.dispatch({ effects: refresh.of(null) });
    },
  };
}
