import { MarkdownRenderChild, type MarkdownPostProcessorContext } from 'obsidian';
import { isCodeBlockEnabled, parseCodeBlocks, reportDiagnostics, type CodeBlock } from './codeblock';
import { copyCode, createExpandFooter, createHeader, setHeaderFoldState } from './render';
import { ReadingCodeLayout, shouldShowLineNumbers } from './line-numbers';
import type { FoldState, MottoSettings } from './settings';
import { hasFoldableHeader, initialOutputState, nextFoldState, nextOutputState, noteFoldOverride, noteOutputOverride, outputPreviewLineCount, previewLineCount, resolveFoldState, type NoteFoldAction, type OutputState } from './folding';
import { ReadingCommandView, ReadingOutputView } from './command-reading';
import { ansiPreview } from './command-render';
import { splitCommands } from './commands';
import { ReadingSessionMenu, type SessionOutputAction, type SessionPromptMode } from './session-menu';

interface SessionState {
  outputAction?: SessionOutputAction;
  expandOutputOwners?: boolean;
  prompt?: SessionPromptMode;
}

interface ReadingDocument {
  path: string;
  source: string;
  sessions: Map<number, SessionState>;
}

interface Mount {
  child: MarkdownRenderChild;
  header: HTMLElement | null;
  block: CodeBlock;
  document: ReadingDocument;
  foldState: FoldState;
  foldOverride: FoldState | undefined;
  expandFooter: HTMLDivElement | null;
  layout: { destroy(): void } | null;
  outputState: OutputState | undefined;
  wrappedCommands: Set<number>;
  sessionMenu?: ReadingSessionMenu;
}

interface NoteFolds {
  path: string;
  bodyAction?: 'fold-blocks' | 'expand-blocks';
  outputAction?: 'close-outputs' | 'open-outputs';
  expandOutputOwners?: boolean;
}

export class ReadingHeaders {
  private readonly mounts = new Map<HTMLElement, Mount>();
  private readonly documents = new WeakMap<Document | HTMLElement, Map<string, ReadingDocument>>();
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

  async process(element: HTMLElement, context: MarkdownPostProcessorContext, previewSource?: string): Promise<void> {
    if (this.disposed || element.closest('.markdown-source-view')) return;
    this.foldsFor(element, context.sourcePath, true);
    const pres = [
      ...(element.matches('pre') ? [element] : []),
      ...element.querySelectorAll<HTMLElement>('pre'),
    ].filter((pre) => pre.querySelector(':scope > code') && !pre.closest('.motto-command-view, .motto-ansi-view'));
    if (pres.length === 0) return;
    const source = previewSource ?? await this.readSource(context.sourcePath);
    if (this.disposed || source === undefined) return;
    const settings = this.getSettings();
    const result = parseCodeBlocks(source, settings);
    reportDiagnostics(result.diagnostics, context.sourcePath);
    const usedByDocument = new Map<ReadingDocument, Set<number>>();
    for (const pre of pres) {
      const scope = pre.closest<HTMLElement>('.markdown-preview-view, .markdown-embed') ?? pre.ownerDocument;
      const document = this.documentFor(scope, context, source);
      let used = usedByDocument.get(document);
      if (!used) {
        used = new Set([...this.mounts.values()].filter((mount) => mount.document === document)
          .map((mount) => mount.block.from));
        usedByDocument.set(document, used);
      }
      const existing = this.mounts.get(pre);
      if (existing?.document === document) used.delete(existing.block.from);
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
        if (existing.document !== document) {
          existing.sessionMenu?.destroy();
          delete existing.sessionMenu;
        }
        this.updateBlock(existing, block);
        existing.document = document;
        this.render(pre, existing);
        continue;
      }
      const child = new MarkdownRenderChild(pre);
      const mount: Mount = {
        child, header: null, block, document,
        foldState: 'expanded', foldOverride: undefined, expandFooter: null, layout: null, outputState: undefined,
        wrappedCommands: new Set(),
      };
      const folds = this.foldsFor(pre, context.sourcePath);
      const session = this.sessionFor(mount);
      const output = block.terminal?.output;
      const action = output && (session?.expandOutputOwners || folds?.expandOutputOwners) ? 'open-outputs' : folds?.bodyAction;
      if (action) mount.foldOverride = noteFoldOverride(block, settings, action);
      if (output) {
        const outputAction = session?.outputAction ?? folds?.outputAction;
        if (outputAction) mount.outputState = this.bulkOutputState(output, outputAction);
      }
      this.mounts.set(pre, mount);
      child.register(() => {
        mount.sessionMenu?.destroy();
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

  private documentFor(scope: Document | HTMLElement, context: MarkdownPostProcessorContext, source: string): ReadingDocument {
    let documents = this.documents.get(scope);
    if (!documents) this.documents.set(scope, documents = new Map());
    const current = documents.get(context.docId);
    if (current?.path === context.sourcePath && current.source === source) return current;
    // Keep defaults through lazy unmounts, but retire old renderings when another one starts.
    const mounted = new Set([...this.mounts.values()].map((mount) => mount.document));
    for (const [id, document] of documents) if (!mounted.has(document)) documents.delete(id);
    const document: ReadingDocument = { path: context.sourcePath, source, sessions: new Map() };
    documents.set(context.docId, document);
    return document;
  }

  private sessionFor(mount: Mount): SessionState | undefined {
    const from = mount.block.terminal?.sessionFrom;
    return from === undefined ? undefined : mount.document.sessions.get(from);
  }

  private createSessionMenu(pre: HTMLElement, mount: Mount): ReadingSessionMenu {
    return new ReadingSessionMenu(pre.ownerDocument, () => {
      const from = mount.block.terminal?.sessionFrom;
      if (from === undefined) return;
      const blocks = parseCodeBlocks(mount.document.source, this.getSettings()).blocks
        .filter((block) => block.terminal?.sessionFrom === from);
      const commands = blocks.flatMap((block) =>
        splitCommands(block.text, block.language).map((range) => block.text.slice(range.from, range.to)));
      const document = mount.document;
      const act = (update: (state: SessionState) => void, redraw: () => void) => {
        if (this.mounts.get(pre) !== mount || mount.document !== document || mount.block.terminal?.sessionFrom !== from) return;
        const state = this.sessionFor(mount) ?? {};
        document.sessions.set(from, state);
        update(state);
        this.preserveScroll(pre, redraw);
      };
      return {
        hasCommands: commands.length > 0,
        hasOutputs: blocks.some((block) => block.terminal?.output),
        promptMode: this.sessionFor(mount)?.prompt,
        changeOutputs: (action) => act((state) => {
          state.outputAction = action;
          if (action === 'open-outputs') state.expandOutputOwners = true;
        }, () => this.updateSession(document, blocks, action)),
        changePrompt: (mode) => act((state) => {
          state.prompt = mode;
        }, () => this.updateSession(document, blocks)),
        copyCommands: () => { void copyCode(pre.ownerDocument, commands.join('\n')); },
      };
    });
  }

  private updateSession(document: ReadingDocument, commands: CodeBlock[], action?: SessionOutputAction): void {
    const members = new Set(commands.map((block) => block.from));
    const settings = this.getSettings();
    for (const [pre, mount] of this.mounts) {
      if (mount.document !== document || !members.has(mount.block.from)) continue;
      if (!action) this.render(pre, mount);
      else if (mount.block.terminal?.output) {
        this.setOutputState(mount, this.bulkOutputState(mount.block.terminal.output, action));
        if (action === 'open-outputs') this.setBodyFold(pre, mount, settings, noteFoldOverride(mount.block, settings, action));
      }
    }
    this.renderOutputs((mount, _pre, ownerFrom) => mount.document === document && members.has(ownerFrom));
  }

  private bulkOutputState(output: CodeBlock, action: SessionOutputAction): OutputState {
    return action === 'reset-outputs' ? initialOutputState(output)
      : noteOutputOverride(action);
  }

  private setOutputState(mount: Mount, state: OutputState): void {
    // The existing output toggle retains this object.
    if (mount.outputState) Object.assign(mount.outputState, state);
    else mount.outputState = state;
    if (mount.layout instanceof ReadingCommandView) mount.layout.setOutputState(mount.outputState);
  }

  private setBodyFold(pre: HTMLElement, mount: Mount, settings: MottoSettings, override: FoldState | undefined): void {
    mount.foldOverride = override;
    const state = resolveFoldState(mount.block, settings, override);
    if (mount.foldState !== state) {
      mount.foldState = state;
      if (mount.header) setHeaderFoldState(mount.header, state);
      this.renderBody(pre, mount);
    }
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

    const matches = (mount: Mount, pre: HTMLElement) =>
      mount.document.path === path && container.contains(pre) && !pre.closest('.markdown-embed');
    const documents = new Set<ReadingDocument>();
    for (const scope of [container, ...container.querySelectorAll<HTMLElement>('.markdown-preview-view')]) {
      if (scope.closest('.markdown-embed')) continue;
      for (const document of this.documents.get(scope)?.values() ?? []) {
        if (document.path === path) documents.add(document);
      }
    }
    for (const [pre, mount] of this.mounts) if (matches(mount, pre)) documents.add(mount.document);
    for (const document of documents) {
      for (const session of document.sessions.values()) {
        if (action !== 'fold-blocks' && action !== 'expand-blocks') delete session.outputAction;
        if (action !== 'close-outputs') delete session.expandOutputOwners;
      }
    }
    const settings = this.getSettings();
    for (const [pre, mount] of this.mounts) {
      if (!matches(mount, pre)) continue;
      if (settings.commandBlocks && mount.block.terminal?.output) {
        const state = action === 'reset-folds' ? initialOutputState(mount.block.terminal.output) : noteOutputOverride(action);
        if (state) this.setOutputState(mount, state);
      }
      if (!hasFoldableHeader(mount.block, settings)) continue;
      const override = noteFoldOverride(mount.block, settings, action);
      if (override === undefined && action !== 'reset-folds') continue;
      this.setBodyFold(pre, mount, settings, override);
    }
    this.renderOutputs(matches);
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
      const source = mount.document.source;
      let blocks = parsed.get(source);
      if (!blocks) {
        blocks = new Map(parseCodeBlocks(source, settings)
          .blocks.map((block) => [block.from, block]));
        parsed.set(source, blocks);
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
    if (!settings.commandBlocks || mount.block.terminal?.session !== 'first') {
      mount.sessionMenu?.destroy();
      delete mount.sessionMenu;
    }
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
        candidate.document === mount.document &&
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
        if (owner.layout instanceof ReadingCommandView) owner.layout.setOutputState(state);
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
      output.setOpen(state.open && owner.foldState === 'expanded', preview, expand, owner.block.terminal?.session);
      return;
    }
    if (settings.commandBlocks && mount.block.terminal?.output) {
      mount.outputState ??= initialOutputState(mount.block.terminal.output);
    } else mount.outputState = undefined;
    mount.foldState = resolveFoldState(mount.block, settings, mount.foldOverride);
    const prompt = this.sessionFor(mount)?.prompt;
    const terminal = mount.block.terminal;
    const showPromptHeader = prompt === 'header' && Boolean(terminal?.promptText || terminal?.user || terminal?.host || terminal?.cwd);
    mount.header = createHeader(pre.ownerDocument, this.displayBlock(mount), showPromptHeader
      ? { ...settings, headerDisplay: 'always' } : settings, hasFoldableHeader(mount.block, settings) ? {
      state: mount.foldState,
      toggle: () => this.preserveScroll(pre, () => {
        mount.foldState = nextFoldState(mount.block, this.getSettings(), mount.foldState);
        mount.foldOverride = mount.foldState;
        if (mount.header) setHeaderFoldState(mount.header, mount.foldState);
        this.renderBody(pre, mount);
        this.renderOutputs();
      }),
    } : undefined);
    if (!mount.header) {
      mount.foldState = 'expanded';
      mount.foldOverride = undefined;
    }
    pre.classList.toggle('motto-code-block', mount.header !== null);
    if (mount.header) {
      if (mount.block.terminal?.session) mount.header.dataset.commandSession = mount.block.terminal.session;
      pre.before(mount.header);
    }
    this.renderBody(pre, mount);
  }

  private displayBlock(mount: Mount): CodeBlock {
    const prompt = this.sessionFor(mount)?.prompt;
    const block = mount.block;
    if (!prompt || !block.terminal) return block;
    const terminal = { ...block.terminal };
    if (prompt === 'header') delete terminal.promptDisplay;
    else terminal.promptDisplay = prompt;
    return { ...block, terminal };
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
    if (mount.expandFooter && mount.block.terminal?.session) {
      mount.expandFooter.dataset.commandSession = mount.block.terminal.session;
    }
    if (settings.commandBlocks && mount.block.terminal) {
      const output = mount.block.terminal.output;
      const outputState = mount.outputState;
      if (mount.block.terminal.session === 'first') mount.sessionMenu ??= this.createSessionMenu(pre, mount);
      const folded = mount.foldState === 'folded';
      mount.layout = new ReadingCommandView(pre, this.displayBlock(mount), mount.wrappedCommands, settings.outputToggleStyles,
        mount.foldState, preview, outputState,
        output && outputState ? () => this.preserveScroll(pre, () => {
          Object.assign(outputState, nextOutputState(output, outputState));
          if (mount.layout instanceof ReadingCommandView) mount.layout.setOutputState(outputState);
          this.renderOutputs();
        }) : undefined, settings.tapMyHippo, settings.commandSpacing, folded ? undefined : mount.sessionMenu);
      if (folded && mount.header && mount.sessionMenu) {
        const controls = mount.header.querySelector<HTMLElement>('.motto-header-controls');
        if (controls) mount.sessionMenu.attach(mount.header, controls);
      }
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

  private renderOutputs(matches?: (mount: Mount, pre: HTMLElement, ownerFrom: number) => boolean): void {
    for (const [pre, mount] of this.mounts) {
      const from = mount.block.commandFrom;
      if (from !== undefined && (!matches || matches(mount, pre, from))) this.render(pre, mount);
    }
  }
}
