import { MarkdownView, Plugin, TFile } from 'obsidian';
import { createEditorHeaders } from './editor';
import type { NoteFoldAction } from './folding';
import { ReadingHeaders } from './reading';
import { parseSettings, type MottoSettings } from './settings';
import { MottoSettingsTab } from './settings-tab';

const noteFoldCommands: Record<NoteFoldAction, string> = {
  'fold-blocks': 'Fold all code blocks',
  'expand-blocks': 'Expand all code blocks',
  'close-outputs': 'Close all command outputs',
  'open-outputs': 'Open all command outputs',
  'reset-folds': 'Reset block folding and output visibility',
};

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
    this.registerMarkdownPostProcessor((element, context) => reading.process(element, context));
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
    this.addSettingTab(new MottoSettingsTab(this.app, this));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.reading?.refresh();
    this.editorHeaders?.refresh();
  }
}
