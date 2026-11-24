import { MarkdownRenderChild, type MarkdownPostProcessorContext } from 'obsidian';
import { isCodeBlockEnabled, parseCodeBlocks, reportDiagnostics, type CodeBlock } from './codeblock';
import { createExpandFooter, createHeader, setHeaderFoldState } from './render';
import { ReadingCodeLayout, shouldShowLineNumbers } from './line-numbers';
import type { FoldState, MottoSettings } from './settings';
import { initialOutputState, nextFoldState, nextOutputState, noteFoldOverride, noteOutputOverride, outputPreviewLineCount, previewLineCount, resolveFoldState, type NoteFoldAction, type OutputState } from './folding';
import { ReadingCommandView, ReadingOutputView } from './command-reading';
import { ansiPreview } from './command-render';

interface Mount {
  child: MarkdownRenderChild;
  header: HTMLElement | null;
  block: CodeBlock;
  docId: string;
  sourcePath: string;
  source: string;
  foldState: FoldState;
  foldOverride: FoldState | undefined;
  expandFooter: HTMLDivElement | null;
  layout: { destroy(): void } | null;
  outputState: OutputState | undefined;
  wrappedCommands: Set<number>;
}

interface NoteFolds {
  path: string;
  bodyAction?: 'fold-blocks' | 'expand-blocks';
  outputAction?: 'close-outputs' | 'open-outputs';
  expandOutputOwners?: boolean;
}

export class ReadingHeaders {
  private readonly mounts = new Map<HTMLElement, Mount>();
  private readonly noteFolds = new WeakMap<HTMLElement, NoteFolds>();
  private readonly pendingScroll = new WeakMap<HTMLElement, AbortController>();
  private readonly readSource: (path: string) => Promise<string | undefined>;
  private readonly getSettings: () => MottoSettings;
  private disposed = false;

  constructor(
    readSource: (path: string) => Promise<string | undefined>,
    getSettings: () => MottoSettings,
  ) {
    this.readSource = readSource;
    this.getSettings = getSettings;
  }

  async process(element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> {
    if (this.disposed || element.closest('.markdown-source-view')) return;
    this.foldsFor(element, context.sourcePath, true);
    const pres = [
      ...(element.matches('pre') ? [element] : []),
      ...element.querySelectorAll<HTMLElement>('pre'),
    ].filter((pre) => pre.querySelector(':scope > code') && !pre.closest('.motto-command-view, .motto-ansi-view'));
    if (pres.length === 0) return;
    const source = await this.readSource(context.sourcePath);
    if (this.disposed || source === undefined) return;
    const settings = this.getSettings();
    const result = parseCodeBlocks(source, settings);
    reportDiagnostics(result.diagnostics, context.sourcePath);
    const used = new Set<number>();
    for (const mount of this.mounts.values()) {
      if (mount.docId === context.docId && mount.sourcePath === context.sourcePath && mount.source === source) {
        used.add(mount.block.from);
      }
    }
    for (const pre of pres) {
      const existing = this.mounts.get(pre);
      if (existing) used.delete(existing.block.from);
      const code = pre.querySelector<HTMLElement>(':scope > code')!;
      const section = context.getSectionInfo(code);
      if (!section) {
        console.warn(`[Motto Code Block] Source positions unavailable for a code block in "${context.sourcePath}".`);
        continue;
      }
      const text = (code.textContent ?? '').replaceAll('\r\n', '\n');
      const block = result.blocks.find((candidate) =>
        !used.has(candidate.from) && candidate.startLine >= section.lineStart && candidate.endLine <= section.lineEnd &&
        (text === candidate.text || text === `${candidate.text}\n`));
      if (!block) {
        existing?.child.unload();
        continue;
      }
      used.add(block.from);
      if (existing) {
        this.updateBlock(existing, block);
        existing.source = source;
        existing.sourcePath = context.sourcePath;
        existing.docId = context.docId;
        this.render(pre, existing);
        continue;
      }
      const child = new MarkdownRenderChild(pre);
      const mount: Mount = {
        child, header: null, block, docId: context.docId, sourcePath: context.sourcePath, source,
        foldState: 'expanded', foldOverride: undefined, expandFooter: null, layout: null, outputState: undefined,
        wrappedCommands: new Set(),
      };
      const folds = this.foldsFor(pre, context.sourcePath);
      if (folds) {
        const action = folds.expandOutputOwners && block.terminal?.output ? 'open-outputs' : folds.bodyAction;
        if (action) mount.foldOverride = noteFoldOverride(block, settings, action);
        if (block.terminal?.output && folds.outputAction) mount.outputState = noteOutputOverride(folds.outputAction);
      }
      this.mounts.set(pre, mount);
      child.register(() => {
        mount.header?.remove();
        mount.expandFooter?.remove();
        mount.layout?.destroy();
        pre.classList.remove('motto-code-block', 'motto-code-block-collapsed');
        this.mounts.delete(pre);
        if (!this.disposed) this.renderOutputs();
      });
      this.render(pre, mount);
      context.addChild(child);
    }
    this.renderOutputs();
  }

  setNoteFolds(container: HTMLElement, path: string, action: NoteFoldAction): void {
    // Keep the bulk defaults for Reading View sections that are mounted later.
    const previous = this.noteFolds.get(container);
    const folds = previous?.path === path ? previous : { path };
    if (action === 'reset-folds') this.noteFolds.delete(container);
    else {
      if (action === 'fold-blocks' || action === 'expand-blocks') {
        folds.bodyAction = action;
        folds.expandOutputOwners = false;
      } else {
        folds.outputAction = action;
        if (action === 'open-outputs') folds.expandOutputOwners = true;
      }
      this.noteFolds.set(container, folds);
    }

    const settings = this.getSettings();
    for (const [pre, mount] of this.mounts) {
      if (mount.sourcePath !== path || !container.contains(pre) || pre.closest('.markdown-embed')) continue;
      if (settings.commandBlocks && mount.block.terminal?.output) {
        const state = action === 'reset-folds' ? initialOutputState(mount.block.terminal.output) : noteOutputOverride(action);
        if (state) {
          // Keep the state object captured by the existing output toggle.
          if (mount.outputState) Object.assign(mount.outputState, state);
          else mount.outputState = state;
          if (mount.layout instanceof ReadingCommandView) mount.layout.setOutputOpen(state.open);
        }
      }
      if (!mount.header) continue;
      const override = noteFoldOverride(mount.block, settings, action);
      if (override === undefined && action !== 'reset-folds') continue;
      mount.foldOverride = override;
      const state = resolveFoldState(mount.block, settings, override);
      if (mount.foldState !== state) {
        mount.foldState = state;
        setHeaderFoldState(mount.header, state);
        this.renderBody(pre, mount);
      }
    }
    this.renderOutputs(container, path);
  }

  private foldsFor(element: HTMLElement, path: string, clearIfChanged = false): NoteFolds | undefined {
    if (element.closest('.markdown-embed')) return;
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      const folds = this.noteFolds.get(parent);
      if (!folds) continue;
      if (folds.path === path) return folds;
      if (clearIfChanged) this.noteFolds.delete(parent);
      return;
    }
  }

  refresh(): void {
    const parsed = new Map<string, Map<number, CodeBlock>>();
    const settings = this.getSettings();
    for (const mount of this.mounts.values()) {
      let blocks = parsed.get(mount.source);
      if (!blocks) {
        blocks = new Map(parseCodeBlocks(mount.source, settings)
          .blocks.map((block) => [block.from, block]));
        parsed.set(mount.source, blocks);
      }
      const block = blocks.get(mount.block.from);
      if (block) this.updateBlock(mount, block);
    }
    for (const [pre, mount] of this.mounts) this.render(pre, mount);
    this.renderOutputs();
  }

  destroy(): void {
    this.disposed = true;
    for (const mount of [...this.mounts.values()]) mount.child.unload();
    this.mounts.clear();
  }

  private updateBlock(mount: Mount, block: CodeBlock): void {
    if (mount.block.text !== block.text) mount.wrappedCommands.clear();
    if (mount.block.fold !== block.fold || mount.block.previewLines !== block.previewLines) {
      mount.foldOverride = undefined;
    }
    if (mount.block.terminal?.output?.fold !== block.terminal?.output?.fold ||
        mount.block.terminal?.output?.previewLines !== block.terminal?.output?.previewLines ||
        Boolean(mount.block.terminal?.output) !== Boolean(block.terminal?.output)) mount.outputState = undefined;
    mount.block = block;
  }

  private preserveScroll(pre: HTMLElement, update: () => void): void {
    const preview = pre.closest<HTMLElement>('.markdown-preview-view');
    const win = preview?.ownerDocument.defaultView;
    if (!preview || !win) {
      update();
      return;
    }

    this.pendingScroll.get(preview)?.abort();
    const top = preview.scrollTop;
    const restore = () => {
      if (preview.scrollTop !== top) preview.scrollTo({ top, behavior: 'instant' });
    };
    update();
    restore();

    const controller = new AbortController();
    this.pendingScroll.set(preview, controller);
    const { signal } = controller;
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
      preview.addEventListener(type, () => controller.abort(), { signal, capture: true, passive: true });
    }
    // Let the preview's layout and resize observers run before the final correction.
    win.requestAnimationFrame(() => {
      if (signal.aborted) return;
      win.requestAnimationFrame(() => {
        if (!signal.aborted && !this.disposed && preview.isConnected &&
            preview.contains(pre) && this.mounts.has(pre)) restore();
        controller.abort();
      });
    });
  }

  private render(pre: HTMLElement, mount: Mount): void {
    const settings = this.getSettings();
    mount.header?.remove();
    mount.header = null;
    if (!isCodeBlockEnabled(mount.block, settings)) {
      mount.expandFooter?.remove();
      mount.expandFooter = null;
      mount.layout?.destroy();
      mount.layout = null;
      mount.foldState = 'expanded';
      mount.foldOverride = undefined;
      mount.outputState = undefined;
      pre.classList.remove('motto-code-block', 'motto-code-block-collapsed');
      return;
    }
    const owner = settings.commandBlocks && mount.block.commandFrom !== undefined
      ? [...this.mounts.values()].find((candidate) =>
        candidate.docId === mount.docId && candidate.sourcePath === mount.sourcePath && candidate.source === mount.source &&
        candidate.block.from === mount.block.commandFrom && candidate.block.terminal?.output?.from === mount.block.from)
      : undefined;
    if (owner) {
      mount.expandFooter?.remove();
      mount.expandFooter = null;
      mount.foldOverride = undefined;
      pre.classList.remove('motto-code-block', 'motto-code-block-collapsed');
      const state = owner.outputState ??= initialOutputState(mount.block);
      const preview = outputPreviewLineCount(mount.block, state);
      const expand = () => this.preserveScroll(pre, () => {
        state.fullyExpanded = true;
        this.renderOutputs();
      });
      let output: ReadingOutputView;
      if (mount.layout instanceof ReadingOutputView && mount.layout.block.text === mount.block.text &&
          mount.layout.block.language === mount.block.language &&
          mount.layout.block.lineCount === mount.block.lineCount) {
        output = mount.layout;
      } else {
        mount.layout?.destroy();
        output = new ReadingOutputView(pre, mount.block, expand);
        mount.layout = output;
      }
      output.setOpen(state.open && owner.foldState === 'expanded', preview, expand);
      return;
    }
    if (settings.commandBlocks && mount.block.terminal?.output) {
      mount.outputState ??= initialOutputState(mount.block.terminal.output);
    } else mount.outputState = undefined;
    mount.foldState = resolveFoldState(mount.block, settings, mount.foldOverride);
    mount.header = createHeader(pre.ownerDocument, mount.block, settings, {
      state: mount.foldState,
      toggle: () => this.preserveScroll(pre, () => {
        mount.foldState = nextFoldState(mount.block, this.getSettings(), mount.foldState);
        mount.foldOverride = mount.foldState;
        if (mount.header) setHeaderFoldState(mount.header, mount.foldState);
        this.renderBody(pre, mount);
        this.renderOutputs();
      }),
    });
    if (!mount.header) {
      mount.foldState = 'expanded';
      mount.foldOverride = undefined;
    }
    pre.classList.toggle('motto-code-block', mount.header !== null);
    if (mount.header) pre.before(mount.header);
    this.renderBody(pre, mount);
  }

  private renderBody(pre: HTMLElement, mount: Mount): void {
    const settings = this.getSettings();
    mount.layout?.destroy();
    mount.expandFooter?.remove();
    pre.classList.toggle('motto-code-block-collapsed', mount.foldState === 'folded');
    const preview = mount.foldState === 'partial' ? previewLineCount(mount.block, settings) : undefined;
    mount.expandFooter = preview !== undefined
      ? createExpandFooter(pre.ownerDocument, mount.block.lineCount - preview, () => {
        mount.header?.click();
        mount.header?.querySelector<HTMLButtonElement>('.motto-header-toggle')?.focus({ preventScroll: true });
      }) : null;
    if (mount.expandFooter) pre.after(mount.expandFooter);
    if (settings.commandBlocks && mount.block.terminal) {
      const output = mount.block.terminal.output;
      const outputState = mount.outputState;
      mount.layout = new ReadingCommandView(pre, mount.block, mount.wrappedCommands, settings.outputToggleStyles,
        mount.foldState, preview, outputState?.open === true,
        output && outputState ? () => this.preserveScroll(pre, () => {
          Object.assign(outputState, nextOutputState(output, outputState));
          if (mount.layout instanceof ReadingCommandView) mount.layout.setOutputOpen(outputState.open);
          this.renderOutputs();
        }) : undefined, settings.tapMyHippo, settings.commandSpacing);
      return;
    }
    if (mount.block.language === 'ansi') {
      pre.classList.add('motto-command-native');
      const view = mount.foldState === 'folded'
        ? null : ansiPreview(pre.ownerDocument, mount.block, settings, preview);
      if (view) {
        view.element.hidden = pre.hidden;
        pre.before(view.element);
      }
      mount.layout = {
        destroy: () => {
          view?.destroy();
          view?.element.remove();
          pre.classList.remove('motto-command-native');
        },
      };
      return;
    }
    const code = pre.querySelector<HTMLElement>(':scope > code')!;
    const numbered = shouldShowLineNumbers(settings.lineNumbers, mount.block.lineCount);
    mount.layout = numbered || preview !== undefined
      ? new ReadingCodeLayout(pre, code, mount.block.lineCount, numbered, preview)
      : null;
  }

  private renderOutputs(container?: HTMLElement, path?: string): void {
    for (const [pre, mount] of this.mounts) {
      if (container && (mount.sourcePath !== path || !container.contains(pre) || pre.closest('.markdown-embed'))) continue;
      if (mount.block.commandFrom !== undefined) this.render(pre, mount);
    }
  }
}
