import { Plugin, TFile } from 'obsidian';
import { createEditorHeaders } from './editor';
import { ReadingHeaders } from './reading';
import { parseSettings, type MottoSettings } from './settings';
import { MottoSettingsTab } from './settings-tab';

export default class MottoCodeblockPlugin extends Plugin {
  override settings: MottoSettings = parseSettings(null);
  private reading: ReadingHeaders | undefined;
  private editorHeaders: ReturnType<typeof createEditorHeaders> | undefined;

  override async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    this.reading = new ReadingHeaders(async (path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        console.warn(`[Motto Codeblock] Cannot locate Markdown source: "${path}".`);
        return undefined;
      }
      return this.app.vault.cachedRead(file);
    }, () => this.settings);
    const reading = this.reading;
    this.register(() => reading.destroy());
    this.registerMarkdownPostProcessor((element, context) => reading.process(element, context));
    this.editorHeaders = createEditorHeaders(() => this.settings);
    this.registerEditorExtension(this.editorHeaders.extension);
    this.addSettingTab(new MottoSettingsTab(this.app, this));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.reading?.refresh();
    this.editorHeaders?.refresh();
  }
}
