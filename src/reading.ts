import { MarkdownRenderChild, type MarkdownPostProcessorContext } from 'obsidian';
import { parseCodeBlocks, reportDiagnostics, type CodeBlock } from './codeblock';
import { createExpandFooter, createHeader, setHeaderFoldState } from './render';
import { ReadingCodeLayout, shouldShowLineNumbers } from './line-numbers';
import { isLanguageEnabled, type FoldState, type MottoSettings } from './settings';
import { initialOutputState, nextFoldState, nextOutputState, outputPreviewLineCount, previewLineCount, resolveFoldState, type OutputState } from './folding';
import { ReadingCommandView, ReadingOutputView } from './command-reading';
import { ansiPreview } from './command-render';

interface Mount {
  child: MarkdownRenderChild;
  header: HTMLElement | null;
  block: CodeBlock;
  docId: string;
  source: string;
  foldState: FoldState;
  foldOverride: FoldState | undefined;
  expandFooter: HTMLDivElement | null;
  layout: { destroy(): void } | null;
  outputState: OutputState | undefined;
}

export class ReadingHeaders {
  private readonly mounts = new Map<HTMLElement, Mount>();
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
    const pres = [
      ...(element.matches('pre') ? [element] : []),
      ...element.querySelectorAll<HTMLElement>('pre'),
    ].filter((pre) => pre.querySelector(':scope > code') && !pre.closest('.motto-command-view, .motto-ansi-view'));
    if (pres.length === 0) return;
    const source = await this.readSource(context.sourcePath);
    if (this.disposed || source === undefined) return;
    const settings = this.getSettings();
    const result = parseCodeBlocks(source, (language) => isLanguageEnabled(language, settings), settings.outputLanguages);
    reportDiagnostics(result.diagnostics, context.sourcePath);
    const used = new Set<number>();
    for (const mount of this.mounts.values()) {
      if (mount.docId === context.docId && mount.source === source) used.add(mount.block.from);
    }
    for (const pre of pres) {
      const existing = this.mounts.get(pre);
      if (existing) used.delete(existing.block.from);
      const code = pre.querySelector<HTMLElement>(':scope > code')!;
      const section = context.getSectionInfo(code);
      if (!section) {
        console.warn(`[Motto Codeblock] Source positions unavailable for a code block in "${context.sourcePath}".`);
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
        this.render(pre, existing);
        continue;
      }
      const child = new MarkdownRenderChild(pre);
      const mount: Mount = {
        child, header: null, block, docId: context.docId, source,
        foldState: 'expanded', foldOverride: undefined, expandFooter: null, layout: null, outputState: undefined,
      };
      this.mounts.set(pre, mount);
      child.register(() => {
        mount.header?.remove();
        mount.expandFooter?.remove();
        mount.layout?.destroy();
        pre.classList.remove('motto-codeblock', 'motto-codeblock-collapsed');
        this.mounts.delete(pre);
        if (!this.disposed) this.renderOutputs();
      });
      this.render(pre, mount);
      context.addChild(child);
    }
    this.renderOutputs();
  }

  refresh(): void {
    const parsed = new Map<string, Map<number, CodeBlock>>();
    const settings = this.getSettings();
    for (const mount of this.mounts.values()) {
      let blocks = parsed.get(mount.source);
      if (!blocks) {
        blocks = new Map(parseCodeBlocks(mount.source, (language) => isLanguageEnabled(language, settings), settings.outputLanguages)
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
    if (mount.block.fold !== block.fold || mount.block.previewLines !== block.previewLines) {
      mount.foldOverride = undefined;
    }
    if (mount.block.terminal?.output?.fold !== block.terminal?.output?.fold ||
        mount.block.terminal?.output?.previewLines !== block.terminal?.output?.previewLines ||
        Boolean(mount.block.terminal?.output) !== Boolean(block.terminal?.output)) mount.outputState = undefined;
    mount.block = block;
  }

  private render(pre: HTMLElement, mount: Mount): void {
    const settings = this.getSettings();
    mount.header?.remove();
    mount.header = null;
    if (mount.block.exclude || !isLanguageEnabled(mount.block.language, settings)) {
      mount.expandFooter?.remove();
      mount.expandFooter = null;
      mount.layout?.destroy();
      mount.layout = null;
      mount.foldState = 'expanded';
      mount.foldOverride = undefined;
      mount.outputState = undefined;
      pre.classList.remove('motto-codeblock', 'motto-codeblock-collapsed');
      return;
    }
    const owner = settings.commandBlocks && mount.block.commandFrom !== undefined
      ? [...this.mounts.values()].find((candidate) =>
        candidate.docId === mount.docId && candidate.source === mount.source &&
        candidate.block.from === mount.block.commandFrom && candidate.block.terminal?.output?.from === mount.block.from)
      : undefined;
    if (owner) {
      mount.expandFooter?.remove();
      mount.expandFooter = null;
      mount.foldOverride = undefined;
      pre.classList.remove('motto-codeblock', 'motto-codeblock-collapsed');
      const state = owner.outputState ??= initialOutputState(mount.block);
      const preview = outputPreviewLineCount(mount.block, state);
      const expand = () => {
        state.fullyExpanded = true;
        this.renderOutputs();
      };
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
      toggle: () => {
        mount.foldState = nextFoldState(mount.block, this.getSettings(), mount.foldState);
        mount.foldOverride = mount.foldState;
        if (mount.header) setHeaderFoldState(mount.header, mount.foldState);
        this.renderBody(pre, mount);
        this.renderOutputs();
      },
    });
    if (!mount.header) {
      mount.foldState = 'expanded';
      mount.foldOverride = undefined;
    }
    pre.classList.toggle('motto-codeblock', mount.header !== null);
    if (mount.header) pre.before(mount.header);
    this.renderBody(pre, mount);
  }

  private renderBody(pre: HTMLElement, mount: Mount): void {
    const settings = this.getSettings();
    mount.layout?.destroy();
    mount.expandFooter?.remove();
    pre.classList.toggle('motto-codeblock-collapsed', mount.foldState === 'folded');
    const preview = mount.foldState === 'partial' ? previewLineCount(mount.block, settings) : undefined;
    mount.expandFooter = preview !== undefined
      ? createExpandFooter(pre.ownerDocument, mount.block.lineCount - preview, () => {
        mount.header?.click();
        mount.header?.querySelector<HTMLButtonElement>('.motto-header-toggle')?.focus();
      }) : null;
    if (mount.expandFooter) pre.after(mount.expandFooter);
    if (settings.commandBlocks && mount.block.terminal) {
      const output = mount.block.terminal.output;
      const outputState = mount.outputState;
      mount.layout = new ReadingCommandView(pre, mount.block, settings.outputToggleStyles,
        mount.foldState, preview, outputState?.open === true,
        output && outputState ? () => {
          Object.assign(outputState, nextOutputState(output, outputState));
          if (mount.layout instanceof ReadingCommandView) mount.layout.setOutputOpen(outputState.open);
          this.renderOutputs();
        } : undefined, settings.tapMyHippo, settings.commandSpacing);
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

  private renderOutputs(): void {
    for (const [pre, mount] of this.mounts) {
      if (mount.block.commandFrom !== undefined) this.render(pre, mount);
    }
  }
}
