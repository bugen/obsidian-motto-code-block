import { Notice, PluginSettingTab, Setting, type App, type ExtraButtonComponent } from 'obsidian';
import type MottoCodeblockPlugin from './main';
import {
  COLOR_MODES, COMMAND_SPACING_MODES, DEFAULT_SETTINGS, FOLD_STATES, HEADER_BACKGROUNDS, HEADER_DISPLAY_MODES,
  ICON_SIZES, LANGUAGE_LABEL_STYLES, LINE_NUMBER_MODES, OUTPUT_TOGGLE_ICONS,
  isChoice, isPositiveInteger, normalizeLanguageList,
  type ColorMode, type HeaderStyleSettings, type MottoSettings, type OutputToggleStyleSettings,
} from './settings';

export class MottoSettingsTab extends PluginSettingTab {
  private readonly motto: MottoCodeblockPlugin;
  private colorMode: ColorMode;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(app: App, motto: MottoCodeblockPlugin) {
    super(app, motto);
    this.motto = motto;
    this.colorMode = this.containerEl.ownerDocument.body.classList.contains('theme-dark') ? 'dark' : 'light';
  }

  override display(): void {
    this.containerEl.empty();
    this.addLanguageList('languageWhitelist', 'Language whitelist',
      'Enhance only these fence names. Separate with commas, spaces or new lines; case-insensitive, exact names only. Aliases are separate entries. Use plaintext for unlabelled blocks. Empty disables all enhancements.');
    this.addLanguageList('languageBlacklist', 'Language blacklist',
      'Never enhance these fence names, even when whitelisted. Same format as the whitelist. Mermaid is excluded by default to preserve native rendering.');
    this.addToggle('commandBlocks', 'Command blocks', 'Enhance supported shell blocks marked cmd/command, containing execution metadata, or immediately followed by a configured output block.');
    this.addLanguageList('outputLanguages', 'Output languages',
      'Fence languages treated as command output when immediately after a supported shell block. Default: ansi. Add text, json or xml as needed. Separate with commas, spaces or new lines; case-insensitive, exact names only. Use plaintext for unlabelled blocks. Language eligibility and exclude still apply. Empty disables output pairing.');
    new Setting(this.containerEl).setName('Command spacing')
      .setDesc('Vertical spacing between commands in the same block. Small keeps the original spacing; Middle is the default. Continued lines are unchanged.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({ small: 'Small', middle: 'Middle', large: 'Large' })
          .setValue(this.motto.settings.commandSpacing).onChange(async (value) => {
            if (!isChoice(value, COMMAND_SPACING_MODES)) return this.invalidChoice();
            await this.save((settings) => ({ ...settings, commandSpacing: value }));
          });
      }).addExtraButton(this.resetButton(() =>
        this.save((settings) => ({ ...settings, commandSpacing: DEFAULT_SETTINGS.commandSpacing }), true)));
    this.addToggle('tapMyHippo', 'Tap my hip-po!',
      'Occasionally show a playful speech bubble when the active output icon is Hippo and its output is closed. Click the icon while the bubble is visible for a reply. Applies to both color modes.');
    new Setting(this.containerEl).setName('Header display')
      .setDesc('Default: show only for supported parameters, such as title, user, host or fold. Command flags and unknown options do not count. Always: show for every block. None: hide.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({ default: 'Default', always: 'Always', none: 'None' })
          .setValue(this.motto.settings.headerDisplay).onChange(async (value) => {
            if (!isChoice(value, HEADER_DISPLAY_MODES)) return this.invalidChoice();
            await this.save((settings) => ({ ...settings, headerDisplay: value }));
          });
      }).addExtraButton(this.resetButton(() =>
        this.save((settings) => ({ ...settings, headerDisplay: DEFAULT_SETTINGS.headerDisplay }), true)));
    this.addToggle('showIcon', 'Show icon', 'Display a language logo, or a standard icon when no logo is available.');
    this.addToggle('showLanguage', 'Show language label', 'Display the code block language name.');
    this.addToggle('showHeaderCopyButton', 'Show header copy button', 'Display a copy button in code block headers. Does not affect body, command or output copy buttons.');
    new Setting(this.containerEl).setName('Line numbers')
      .setDesc('Default: show for two or more lines. Always: show for every block. None: hide.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({ default: 'Default', always: 'Always', none: 'None' })
          .setValue(this.motto.settings.lineNumbers).onChange(async (value) => {
            if (!isChoice(value, LINE_NUMBER_MODES)) return this.invalidChoice();
            await this.save((settings) => ({ ...settings, lineNumbers: value }));
          });
      }).addExtraButton(this.resetButton(() =>
        this.save((settings) => ({ ...settings, lineNumbers: DEFAULT_SETTINGS.lineNumbers }), true)));
    new Setting(this.containerEl).setName('Default fold state')
      .setDesc('Initial state when fold, expand or unfold is not specified. Explicit options take precedence.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({ expanded: 'Expanded', folded: 'Folded', partial: 'Partial preview' })
          .setValue(this.motto.settings.defaultFoldState).onChange(async (value) => {
            if (!isChoice(value, FOLD_STATES)) return this.invalidChoice();
            await this.save((settings) => ({ ...settings, defaultFoldState: value }));
          });
      }).addExtraButton(this.resetButton(() =>
        this.save((settings) => ({ ...settings, defaultFoldState: DEFAULT_SETTINGS.defaultFoldState }), true)));
    new Setting(this.containerEl).setName('Partial preview lines')
      .setDesc('Number of initial body lines shown in partial previews. An explicit expand:N takes precedence.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.step = '1';
        text.inputEl.setAttribute('aria-label', 'Partial preview lines');
        text.setValue(String(this.motto.settings.partialFoldLines));
        text.inputEl.addEventListener('change', async () => {
          const value = Number(text.getValue());
          if (!isPositiveInteger(value)) {
            new Notice('Motto Codeblock: Enter a positive whole number of lines.');
            text.setValue(String(this.motto.settings.partialFoldLines));
            return;
          }
          await this.save((settings) => ({ ...settings, partialFoldLines: value }));
        });
      }).addExtraButton(this.resetButton(() =>
        this.save((settings) => ({ ...settings, partialFoldLines: DEFAULT_SETTINGS.partialFoldLines }), true)));
    new Setting(this.containerEl).setName('Appearance').setHeading();
    new Setting(this.containerEl)
      .setName('Color mode')
      .setDesc('Choose which appearance to edit. This does not change Obsidian\'s theme.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({ light: 'Light mode', dark: 'Dark mode' }).setValue(this.colorMode)
          .onChange(async (value) => {
            if (!isChoice(value, COLOR_MODES)) return this.invalidChoice();
            await this.saveQueue;
            this.colorMode = value;
            this.display();
          });
      });
    new Setting(this.containerEl).setName('Output toggle appearance').setHeading();
    this.addOutputToggleAppearance(this.colorMode);
    new Setting(this.containerEl).setName('Header appearance').setHeading();
    this.addAppearance(this.colorMode);
  }

  private addLanguageList(
    key: 'languageWhitelist' | 'languageBlacklist' | 'outputLanguages', name: string, description: string,
  ): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addTextArea((text) => {
      text.inputEl.rows = key === 'languageWhitelist' ? 6 : 3;
      text.inputEl.cols = 36;
      text.inputEl.setAttribute('aria-label', name);
      text.setValue(this.motto.settings[key].join('\n'));
      text.inputEl.addEventListener('change', async () => {
        const value = normalizeLanguageList(text.getValue());
        await this.save((settings) => ({ ...settings, [key]: value }));
      });
    }).addExtraButton(this.resetButton(() =>
      this.save((settings) => ({ ...settings, [key]: [...DEFAULT_SETTINGS[key]] }), true)));
  }

  private addOutputToggleAppearance(mode: ColorMode): void {
    const style = this.motto.settings.outputToggleStyles[mode];
    new Setting(this.containerEl).setName('Output toggle icon')
      .setDesc('Choose the icon pair used to show and hide output.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({
          eye: 'Eye', monitor: 'Monitor', expand: 'Expand / collapse', book: 'Book', chevron: 'Up / down chevrons',
          hippo: 'Hippo',
        }).setValue(style.icon).onChange(async (value) => {
          if (!isChoice(value, OUTPUT_TOGGLE_ICONS)) return this.invalidChoice();
          await this.saveOutputToggleStyle(mode, { icon: value });
        });
      }).addExtraButton(this.resetOutputToggleStyleButton(mode, 'icon'));
    new Setting(this.containerEl).setName('Reverse output toggle icons')
      .setDesc('Swap the show/hide icons for this color mode. Does not change output visibility.')
      .addToggle((toggle) => {
        toggle.setValue(style.reverseIcons).onChange(async (value) => {
          await this.saveOutputToggleStyle(mode, { reverseIcons: value });
        });
      }).addExtraButton(this.resetOutputToggleStyleButton(mode, 'reverseIcons'));
    new Setting(this.containerEl).setName('Override output toggle color')
      .setDesc('Off: automatic, matching the adjacent copy button.')
      .addToggle((toggle) => {
        toggle.setValue(style.overrideColor).onChange(async (value) => {
          await this.saveOutputToggleStyle(mode, { overrideColor: value }, true);
        });
      }).addExtraButton(this.resetOutputToggleStyleButton(mode, 'overrideColor'));
    if (style.overrideColor) {
      new Setting(this.containerEl).setName('Output toggle color').addColorPicker((picker) => {
        picker.setValue(style.color).onChange(async (value) => {
          await this.saveOutputToggleStyle(mode, { color: value });
        });
      }).addExtraButton(this.resetOutputToggleStyleButton(mode, 'color'));
    }
  }

  private addToggle(
    key: 'commandBlocks' | 'tapMyHippo' | 'showIcon' | 'showLanguage' | 'showHeaderCopyButton',
    name: string,
    description: string,
  ): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addToggle((toggle) => {
      toggle.setValue(this.motto.settings[key]).onChange(async (value) => {
        await this.save((settings) => ({ ...settings, [key]: value }));
      });
    }).addExtraButton(this.resetButton(() =>
      this.save((settings) => ({ ...settings, [key]: DEFAULT_SETTINGS[key] }), true)));
  }

  private addAppearance(mode: ColorMode): void {
    const style = this.motto.settings.headerStyles[mode];
    new Setting(this.containerEl).setName('Header background')
      .setDesc('Based on the code block background; the code itself is not changed.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({
          code: 'Same as code block', darker: 'Slightly darker', lighter: 'Slightly lighter', custom: 'Custom color',
        }).setValue(style.background).onChange(async (value) => {
          if (!isChoice(value, HEADER_BACKGROUNDS)) return this.invalidChoice();
          await this.saveStyle(mode, { background: value }, true);
        });
      }).addExtraButton(this.resetStyleButton(mode, 'background'));
    if (style.background === 'custom') {
      new Setting(this.containerEl).setName('Custom background color').addColorPicker((picker) => {
        picker.setValue(style.backgroundColor).onChange(async (value) => {
          await this.saveStyle(mode, { backgroundColor: value });
        });
      }).addExtraButton(this.resetStyleButton(mode, 'backgroundColor'));
    }
    new Setting(this.containerEl).setName('Icon size').addDropdown((dropdown) => {
      dropdown.addOptions({ large: 'Large (32 px)', medium: 'Medium (28 px)', small: 'Small (24 px)' })
        .setValue(style.iconSize).onChange(async (value) => {
          if (!isChoice(value, ICON_SIZES)) return this.invalidChoice();
          await this.saveStyle(mode, { iconSize: value });
        });
    }).addExtraButton(this.resetStyleButton(mode, 'iconSize'));
    new Setting(this.containerEl).setName('Title').setHeading();
    this.addTitleToggle(mode, 'titleBold', 'Bold title');
    this.addTitleToggle(mode, 'titleItalic', 'Italic title');
    new Setting(this.containerEl).setName('Title font size')
      .setDesc('A positive whole number of pixels. Default: 14.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.step = '1';
        text.inputEl.setAttribute('aria-label', 'Title font size in pixels');
        text.setValue(String(style.titleFontSize));
        text.inputEl.addEventListener('change', async () => {
          const value = Number(text.getValue());
          if (!isPositiveInteger(value)) {
            new Notice('Motto Codeblock: Enter a positive whole number of pixels.');
            text.setValue(String(this.motto.settings.headerStyles[mode].titleFontSize));
            return;
          }
          await this.saveStyle(mode, { titleFontSize: value });
        });
      }).addExtraButton(this.resetStyleButton(mode, 'titleFontSize'));
    this.addTitleToggle(mode, 'overrideTitleColor', 'Override title color', true);
    if (style.overrideTitleColor) {
      new Setting(this.containerEl).setName('Custom title color').addColorPicker((picker) => {
        picker.setValue(style.titleColor).onChange(async (value) => {
          await this.saveStyle(mode, { titleColor: value });
        });
      }).addExtraButton(this.resetStyleButton(mode, 'titleColor'));
    }
    new Setting(this.containerEl).setName('Language label style')
      .setDesc('The label background follows the header color, including header-style overrides.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({ default: 'Default', emphasized: 'Emphasized (dark background, white text)' })
          .setValue(style.languageLabel).onChange(async (value) => {
            if (!isChoice(value, LANGUAGE_LABEL_STYLES)) return this.invalidChoice();
            await this.saveStyle(mode, { languageLabel: value });
          });
      }).addExtraButton(this.resetStyleButton(mode, 'languageLabel'));
  }

  private addTitleToggle(
    mode: ColorMode,
    key: 'titleBold' | 'titleItalic' | 'overrideTitleColor',
    name: string,
    redraw = false,
  ): void {
    new Setting(this.containerEl).setName(name).addToggle((toggle) => {
      toggle.setValue(this.motto.settings.headerStyles[mode][key]).onChange(async (value) => {
        await this.saveStyle(mode, { [key]: value }, redraw);
      });
    }).addExtraButton(this.resetStyleButton(mode, key));
  }

  private resetStyleButton(mode: ColorMode, key: keyof HeaderStyleSettings): (button: ExtraButtonComponent) => void {
    return this.resetButton(() => this.saveStyle(mode, { [key]: DEFAULT_SETTINGS.headerStyles[mode][key] }, true));
  }

  private resetOutputToggleStyleButton(
    mode: ColorMode, key: keyof OutputToggleStyleSettings,
  ): (button: ExtraButtonComponent) => void {
    return this.resetButton(() =>
      this.saveOutputToggleStyle(mode, { [key]: DEFAULT_SETTINGS.outputToggleStyles[mode][key] }, true));
  }

  private resetButton(reset: () => Promise<void>): (button: ExtraButtonComponent) => void {
    return (button) => {
      button.setIcon('rotate-ccw').setTooltip('Restore default').onClick(reset);
    };
  }

  private saveStyle(mode: ColorMode, patch: Partial<HeaderStyleSettings>, redraw = false): Promise<void> {
    return this.save((settings) => ({
      ...settings,
      headerStyles: {
        ...settings.headerStyles,
        [mode]: { ...settings.headerStyles[mode], ...patch },
      },
    }), redraw);
  }

  private saveOutputToggleStyle(mode: ColorMode, patch: Partial<OutputToggleStyleSettings>, redraw = false): Promise<void> {
    return this.save((settings) => ({
      ...settings,
      outputToggleStyles: {
        ...settings.outputToggleStyles,
        [mode]: { ...settings.outputToggleStyles[mode], ...patch },
      },
    }), redraw);
  }

  private save(change: (settings: MottoSettings) => MottoSettings, redraw = false): Promise<void> {
    this.saveQueue = this.saveQueue.then(async () => {
      const previous = this.motto.settings;
      this.motto.settings = change(previous);
      try {
        await this.motto.saveSettings();
      } catch (error) {
        this.motto.settings = previous;
        console.error('[Motto Codeblock] Failed to save settings.', error);
        new Notice('Motto Codeblock: Failed to save settings.');
        this.display();
        return;
      }
      if (redraw) this.display();
    });
    return this.saveQueue;
  }

  private invalidChoice(): void {
    console.error('[Motto Codeblock] Invalid setting choice.');
    new Notice('Motto Codeblock: Invalid setting choice.');
    this.display();
  }
}
