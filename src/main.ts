import { MarkdownView, Plugin, TFile } from 'obsidian';
import { createEditorHeaders } from './editor';
import type { NoteFoldAction } from './folding';
import { ReadingHeaders } from './reading';
import { parseSettings, type MottoSettings } from './settings';
import { MottoSettingsTab } from './settings-tab';
import { pasteTerminalTranscript } from './terminal-paste';

const noteFoldCommands: Record<NoteFoldAction, string> = {
  'fold-blocks': 'Fold all code blocks',
  'expand-blocks': 'Expand all code blocks',
  'close-outputs': 'Close all command outputs',
  'open-outputs': 'Open all command outputs',
  'reset-folds': 'Reset block folding and output visibility',
};

const terminalPasteShells = { auto: '', bash: 'Bash ', powershell: 'PowerShell ' } as const;

export default class MottoCodeBlockPlugin extends Plugin {
  override settings: MottoSettings = parseSettings(null);
  private reading: ReadingHeaders | undefined;
  private editorHeaders: ReturnType<typeof createEditorHeaders> | undefined;

  override async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    this.reading = new ReadingHeaders(async (path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        console.warn(`[Motto Code Block] Cannot locate Markdown source: "${path}".`);
        return undefined;
      }
      return this.app.vault.cachedRead(file);
    }, () => this.settings);
    const reading = this.reading;
    this.register(() => reading.destroy());
    this.registerMarkdownPostProcessor((element, context) => {
      const view = !element.closest('.markdown-embed') && this.app.workspace.getLeavesOfType('markdown')
        .map((leaf) => leaf.view)
        .find((view): view is MarkdownView => view instanceof MarkdownView &&
          view.file?.path === context.sourcePath && view.previewMode.containerEl.contains(element));
      // The preview may already contain edits that Obsidian has not saved to the vault yet.
      return reading.process(element, context, view ? view.previewMode.get() : undefined);
    });
    const pending = new Map<MarkdownView, { path: string; observer: MutationObserver }>();
    const updatePreview = (view: MarkdownView) => {
      const entry = pending.get(view);
      if (!entry) return;
      const sameNote = view.file?.path === entry.path && view.containerEl.isConnected;
      if (sameNote && view.getMode() !== 'preview') return;
      entry.observer.disconnect();
      pending.delete(view);
      // Obsidian can reuse rendered sections without running postprocessors after an info-string edit.
      if (sameNote) view.previewMode.rerender(true);
    };
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      const view = info instanceof MarkdownView ? info : this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file || view.editor !== editor || view.getMode() !== 'source') return;
      const existing = pending.get(view);
      if (existing?.path === view.file.path) return;
      existing?.observer.disconnect();
      pending.delete(view);
      const win = view.containerEl.ownerDocument.defaultView;
      if (!win) return;
      const observer = new win.MutationObserver(() => updatePreview(view));
      pending.set(view, { path: view.file.path, observer });
      for (const element of [view.containerEl, view.contentEl, view.previewMode.containerEl]) {
        observer.observe(element, { childList: true, attributeFilter: ['class', 'style', 'hidden', 'data-mode'] });
      }
    }));
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      for (const view of pending.keys()) updatePreview(view);
    }));
    this.register(() => {
      for (const { observer } of pending.values()) observer.disconnect();
      pending.clear();
    });
    this.editorHeaders = createEditorHeaders(() => this.settings);
    this.registerEditorExtension(this.editorHeaders.extension);
    for (const [action, name] of Object.entries(noteFoldCommands) as [NoteFoldAction, string][]) {
      this.addCommand({
        id: action, name,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view?.file) return false;
          if (view.getMode() === 'preview') {
            if (!checking) reading.setNoteFolds(view.previewMode.containerEl, view.file.path, action);
            return true;
          }
          return this.editorHeaders?.setNoteFolds(view.editor, action, checking) ?? false;
        },
      });
    }
    for (const shell of ['auto', 'bash', 'powershell'] as const) {
      for (const ansi of ['keep', 'strip'] as const) {
        this.addCommand({
          id: `paste-${shell === 'auto' ? '' : `${shell}-`}terminal-output-${ansi}-ansi`,
          name: `Paste ${terminalPasteShells[shell]}terminal output (${ansi} ANSI)`,
          editorCheckCallback: (checking, editor, view) => {
            if (!(view instanceof MarkdownView) || !view.file || view.getMode() !== 'source') return false;
            if (!checking) {
              const file = view.file;
              const readClipboard = async () => {
                const clipboard = view.containerEl.ownerDocument.defaultView?.navigator.clipboard;
                if (!clipboard) throw new Error('Clipboard API is unavailable.');
                return clipboard.readText();
              };
              const isCurrent = () => this.app.workspace.getActiveViewOfType(MarkdownView) === view &&
                view.file === file && view.getMode() === 'source';
              void pasteTerminalTranscript(editor, readClipboard, isCurrent, this.settings, ansi === 'keep', shell);
            }
            return true;
          },
        });
      }
    }
    this.addSettingTab(new MottoSettingsTab(this.app, this));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.reading?.refresh();
    this.editorHeaders?.refresh();
  }
}
