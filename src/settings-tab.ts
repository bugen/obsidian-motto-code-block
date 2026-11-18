import { Notice, PluginSettingTab, Setting, setTooltip, type App, type ExtraButtonComponent } from 'obsidian';
import type MottoCodeblockPlugin from './main';
import {
  COLOR_MODES, COMMAND_SPACING_MODES, DEFAULT_SETTINGS, FOLD_STATES, HEADER_BACKGROUNDS, HEADER_DISPLAY_MODES,
  ICON_SIZES, LANGUAGE_LABEL_STYLES, LINE_NUMBER_MODES, OUTPUT_TOGGLE_ICONS,
  isChoice, isPositiveInteger, normalizeLanguageList,
  type ColorMode, type HeaderStyleSettings, type MottoSettings, type OutputToggleStyleSettings,
} from './settings';

type ChoiceKey = 'headerDisplay' | 'lineNumbers' | 'defaultFoldState' | 'commandSpacing';
type ThemeRenderer = (parent: HTMLElement, mode: ColorMode, refresh: () => void) => void;

export class MottoSettingsTab extends PluginSettingTab {
  private readonly motto: MottoCodeblockPlugin;
  private colorMode: ColorMode = 'light';
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly themeRefreshers: (() => void)[] = [];
  private readonly disabledSettings = new Map<Setting, () => boolean>();
  private readonly resetButtons = new Map<HTMLElement, () => boolean>();

  constructor(app: App, motto: MottoCodeblockPlugin) {
    super(app, motto);
    this.motto = motto;
    this.containerEl.classList.add('motto-settings');
  }

  override display(): void {
    this.colorMode = this.containerEl.ownerDocument.body.classList.contains('theme-dark') ? 'dark' : 'light';
    this.render();
  }

  private render(): void {
    this.containerEl.empty();
    this.themeRefreshers.length = 0;
    this.disabledSettings.clear();
    this.resetButtons.clear();
    this.addThemeSelector();

    const general = this.section(this.containerEl, 'General', 2);
    const languages = this.section(general, 'Language eligibility', 3);
    this.addLanguageList(languages, 'languageIncludeList', 'Language include list',
      'Enhance only these fence names. Separate with commas, spaces or new lines; case-insensitive, exact names only. Aliases are separate entries. Use plaintext for unlabelled blocks. Empty disables all enhancements.');
    this.addLanguageList(languages, 'languageExcludeList', 'Language exclude list',
      'Never enhance these fence names, even when present in the include list. Same format as the include list. Mermaid is excluded by default to preserve native rendering.');

    const blocks = this.section(this.containerEl, 'Code blocks', 2);
    const header = this.section(blocks, 'Header', 3);
    const noHeader = () => this.motto.settings.headerDisplay === 'none';
    this.addChoice(header, 'headerDisplay', 'Header display',
      'Default: show only for supported parameters, such as title, user, host or fold. Command flags and unknown options do not count. Always: show for every block. None: hide.',
      HEADER_DISPLAY_MODES, { default: 'Default', always: 'Always', none: 'None' });
    this.addToggle(header, 'showHeaderCopyButton', 'Show header copy button',
      'Display a copy button in code block headers. Does not affect body, command or output copy buttons.', noHeader);
    this.addToggle(header, 'showIcon', 'Show icon',
      'Display a language logo, or a standard icon when no logo is available.', noHeader);
    this.addThemeGroup(header, (parent, mode, refresh) => this.addIconSize(parent, mode, refresh));
    this.addToggle(header, 'showLanguage', 'Show language label', 'Display the code block language name.', noHeader);
    this.addThemeGroup(header, (parent, mode, refresh) => this.addLanguageLabel(parent, mode, refresh));
    this.addThemeGroup(header, (parent, mode, refresh) => this.addBackground(parent, mode, refresh));
    const title = this.section(header, 'Title', 4);
    this.addThemeGroup(title, (parent, mode, refresh) => this.addTitle(parent, mode, refresh));

    const body = this.section(blocks, 'Body', 3);
    this.addChoice(body, 'lineNumbers', 'Line numbers',
      'Default: show for two or more lines. Always: show for every block. None: hide. Command rows and paired output are not numbered.',
      LINE_NUMBER_MODES, { default: 'Default', always: 'Always', none: 'None' });
    const folding = this.section(blocks, 'Folding', 3);
    this.addChoice(folding, 'defaultFoldState', 'Default fold state',
      'Initial body state when fold, expand or unfold is not specified. Explicit options take precedence. Does not set paired output visibility.',
      FOLD_STATES, { expanded: 'Expanded', folded: 'Folded', partial: 'Partial preview' });
    this.addPreviewLines(folding);

    const commands = this.section(this.containerEl, 'Command blocks', 2);
    const noCommands = () => !this.motto.settings.commandBlocks;
    this.addToggle(commands, 'commandBlocks', 'Command blocks',
      'Enhance supported shell blocks marked cmd/command, containing execution metadata, or immediately followed by a configured output block. Standalone ANSI rendering is independent.');
    this.addChoice(commands, 'commandSpacing', 'Command spacing',
      'Vertical spacing between commands in the same block. Small keeps the original spacing; Middle is the default. Continued lines are unchanged.',
      COMMAND_SPACING_MODES, { small: 'Small', middle: 'Middle', large: 'Large' }, noCommands);
    const output = this.section(commands, 'Output', 3);
    this.addLanguageList(output, 'outputLanguages', 'Output languages',
      'Fence languages treated as command output when immediately after a supported shell block. Default: ansi. Add text, json or xml as needed. Separate with commas, spaces or new lines; case-insensitive, exact names only. Use plaintext for unlabelled blocks. Language eligibility and exclude still apply. Empty disables output pairing.',
      noCommands);
    this.addThemeGroup(output, (parent, mode, refresh) => this.addOutputToggleAppearance(parent, mode, refresh));
    this.addToggle(output, 'tapMyHippo', 'Tap my hip-po!',
      'Let hippos speak.',
      noCommands);
    this.updateControlStates();
  }

  private addThemeSelector(): void {
    const setting = new Setting(this.containerEl).setName('Editing theme')
      .setDesc('Only settings marked with ');
    setting.descEl.append(this.createThemeIcon('Separate Light/Dark setting.'),
      ' are separate for Light and Dark. All other settings are shared. This does not change Obsidian\'s theme.');
    setting.controlEl.classList.add('motto-theme-switch');
    setting.controlEl.setAttribute('role', 'group');
    setting.controlEl.setAttribute('aria-label', 'Editing theme');
    const buttons = new Map<ColorMode, HTMLButtonElement>();
    for (const mode of COLOR_MODES) {
      setting.addButton((button) => {
        button.setButtonText(mode === 'light' ? 'Light' : 'Dark');
        button.buttonEl.dataset.mottoTheme = mode;
        button.buttonEl.setAttribute('aria-pressed', String(mode === this.colorMode));
        buttons.set(mode, button.buttonEl);
        button.onClick(async () => {
          await this.saveQueue;
          if (!this.containerEl.contains(setting.settingEl) || this.colorMode === mode) return;
          this.colorMode = mode;
          for (const [value, element] of buttons) element.setAttribute('aria-pressed', String(value === mode));
          this.preserveContext(() => { for (const refresh of this.themeRefreshers) refresh(); });
        });
      });
    }
  }

  private section(parent: HTMLElement, name: string, level: number): HTMLElement {
    const section = parent.ownerDocument.createElement('section');
    section.className = `motto-settings-section motto-settings-level-${level}`;
    parent.append(section);
    const heading = new Setting(section).setName(name).setHeading();
    heading.nameEl.setAttribute('role', 'heading');
    heading.nameEl.setAttribute('aria-level', String(level));
    return section;
  }

  private createSetting(
    parent: HTMLElement, name: string, disabled: () => boolean = () => false, mode?: ColorMode,
  ): Setting {
    const setting = new Setting(parent).setName(name);
    setting.settingEl.dataset.mottoSetting = name;
    this.disabledSettings.set(setting, disabled);
    if (mode !== undefined) {
      const label = `Separate Light/Dark setting. Editing ${mode === 'light' ? 'Light' : 'Dark'}.`;
      setting.nameEl.append(this.createThemeIcon(label));
    }
    return setting;
  }

  private createThemeIcon(label: string): HTMLElement {
    const document = this.containerEl.ownerDocument;
    const marker = document.createElement('span');
    marker.className = 'motto-theme-setting-icon';
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', label);
    setTooltip(marker, label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const half = document.createElementNS(svg.namespaceURI, 'path');
    half.setAttribute('d', 'M12 3a9 9 0 0 0 0 18Z');
    half.setAttribute('fill', 'currentColor');
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '9');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2');
    svg.append(half, circle);
    marker.append(svg);
    return marker;
  }

  private addThemeGroup(parent: HTMLElement, render: ThemeRenderer): void {
    const group = parent.ownerDocument.createElement('div');
    parent.append(group);
    const refresh = () => this.preserveContext(() => {
      if (!this.containerEl.contains(group)) return;
      for (const setting of this.disabledSettings.keys()) {
        if (group.contains(setting.settingEl)) this.disabledSettings.delete(setting);
      }
      group.replaceChildren();
      render(group, this.colorMode, refresh);
      this.updateControlStates();
    });
    this.themeRefreshers.push(refresh);
    refresh();
  }

  private updateControlStates(): void {
    for (const [setting, disabled] of this.disabledSettings) setting.setDisabled(disabled());
    for (const [element, modified] of this.resetButtons) {
      if (!this.containerEl.contains(element)) {
        this.resetButtons.delete(element);
        continue;
      }
      element.classList.toggle('motto-reset-modified', modified());
    }
  }

  private preserveContext(render: () => void): void {
    const active = this.containerEl.ownerDocument.activeElement;
    const row = active?.closest<HTMLElement>('.setting-item');
    const name = row?.dataset.mottoSetting;
    const selector = 'input, select, textarea, button, [tabindex]';
    const index = row ? [...row.querySelectorAll<HTMLElement>(selector)].findIndex((element) => element === active) : -1;
    const scrollTop = this.containerEl.scrollTop;
    render();
    if (name && index >= 0 && active && !this.containerEl.contains(active)) {
      const replacement = [...this.containerEl.querySelectorAll<HTMLElement>('[data-motto-setting]')]
        .find((element) => element.dataset.mottoSetting === name);
      replacement?.querySelectorAll<HTMLElement>(selector)[index]?.focus({ preventScroll: true });
    }
    this.containerEl.scrollTop = scrollTop;
  }

  private addChoice<K extends ChoiceKey>(
    parent: HTMLElement, key: K, name: string, description: string,
    choices: readonly MottoSettings[K][], options: Record<MottoSettings[K], string>,
    disabled: () => boolean = () => false,
  ): void {
    const setting = this.createSetting(parent, name, disabled).setDesc(description);
    setting.addDropdown((dropdown) => {
      dropdown.addOptions(options).setValue(this.motto.settings[key]).onChange(async (value) => {
        if (!isChoice(value, choices)) return this.invalidChoice();
        await this.save((settings) => ({ ...settings, [key]: value }));
      });
      setting.addExtraButton(this.resetButton(() => this.save(
        (settings) => ({ ...settings, [key]: DEFAULT_SETTINGS[key] }),
        () => { dropdown.setValue(this.motto.settings[key]); },
      ), () => this.motto.settings[key] !== DEFAULT_SETTINGS[key]));
    });
  }

  private addLanguageList(
    parent: HTMLElement, key: 'languageIncludeList' | 'languageExcludeList' | 'outputLanguages',
    name: string, description: string, disabled: () => boolean = () => false,
  ): void {
    const setting = this.createSetting(parent, name, disabled).setDesc(description);
    const defaults = new Set(DEFAULT_SETTINGS[key]);
    setting.addTextArea((text) => {
      text.inputEl.rows = key === 'languageIncludeList' ? 6 : 3;
      text.inputEl.cols = 36;
      text.inputEl.setAttribute('aria-label', name);
      text.setValue(this.motto.settings[key].join('\n'));
      text.inputEl.addEventListener('change', async () => {
        const value = normalizeLanguageList(text.getValue());
        await this.save((settings) => ({ ...settings, [key]: value }));
      });
      setting.addExtraButton(this.resetButton(() => this.save(
        (settings) => ({ ...settings, [key]: [...DEFAULT_SETTINGS[key]] }),
        () => { text.setValue(this.motto.settings[key].join('\n')); },
      ), () => {
        const current = this.motto.settings[key];
        return current.length !== defaults.size || current.some((language) => !defaults.has(language));
      }));
    });
  }

  private addToggle(
    parent: HTMLElement, key: 'commandBlocks' | 'tapMyHippo' | 'showIcon' | 'showLanguage' | 'showHeaderCopyButton',
    name: string, description: string, disabled: () => boolean = () => false,
  ): void {
    const setting = this.createSetting(parent, name, disabled).setDesc(description);
    setting.addToggle((toggle) => {
      toggle.setValue(this.motto.settings[key]).onChange(async (value) => {
        await this.save((settings) => ({ ...settings, [key]: value }));
      });
      setting.addExtraButton(this.resetButton(() => this.save(
        (settings) => ({ ...settings, [key]: DEFAULT_SETTINGS[key] }),
        () => { toggle.setValue(this.motto.settings[key]); },
      ), () => this.motto.settings[key] !== DEFAULT_SETTINGS[key]));
    });
  }

  private addPreviewLines(parent: HTMLElement): void {
    const setting = this.createSetting(parent, 'Partial preview lines')
      .setDesc('Number of initial body lines shown in partial previews. An explicit expand:N takes precedence.');
    setting.addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.min = '1';
      text.inputEl.step = '1';
      text.inputEl.setAttribute('aria-label', 'Partial preview lines');
      text.setValue(String(this.motto.settings.partialFoldLines));
      text.inputEl.addEventListener('change', async () => {
        const value = Number(text.getValue());
        if (!isPositiveInteger(value)) {
          new Notice('Motto Code Block: Enter a positive whole number of lines.');
          text.setValue(String(this.motto.settings.partialFoldLines));
          return;
        }
        await this.save((settings) => ({ ...settings, partialFoldLines: value }));
      });
      setting.addExtraButton(this.resetButton(() => this.save(
        (settings) => ({ ...settings, partialFoldLines: DEFAULT_SETTINGS.partialFoldLines }),
        () => { text.setValue(String(this.motto.settings.partialFoldLines)); },
      ), () => this.motto.settings.partialFoldLines !== DEFAULT_SETTINGS.partialFoldLines));
    });
  }

  private addIconSize(parent: HTMLElement, mode: ColorMode, refresh: () => void): void {
    this.createSetting(parent, 'Icon size', () => this.motto.settings.headerDisplay === 'none' || !this.motto.settings.showIcon, mode)
      .addDropdown((dropdown) => {
        dropdown.addOptions({ large: 'Large (32 px)', medium: 'Medium (28 px)', small: 'Small (24 px)' })
          .setValue(this.motto.settings.headerStyles[mode].iconSize).onChange(async (value) => {
            if (!isChoice(value, ICON_SIZES)) return this.invalidChoice();
            await this.saveStyle(mode, { iconSize: value });
          });
      }).addExtraButton(this.resetStyleButton(mode, 'iconSize', refresh));
  }

  private addLanguageLabel(parent: HTMLElement, mode: ColorMode, refresh: () => void): void {
    this.createSetting(parent, 'Language label style',
      () => this.motto.settings.headerDisplay === 'none' || !this.motto.settings.showLanguage, mode)
      .setDesc('The label background follows the header color, including header-style overrides.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({ default: 'Default', emphasized: 'Emphasized (dark background, white text)' })
          .setValue(this.motto.settings.headerStyles[mode].languageLabel).onChange(async (value) => {
            if (!isChoice(value, LANGUAGE_LABEL_STYLES)) return this.invalidChoice();
            await this.saveStyle(mode, { languageLabel: value });
          });
      }).addExtraButton(this.resetStyleButton(mode, 'languageLabel', refresh));
  }

  private addBackground(parent: HTMLElement, mode: ColorMode, refresh: () => void): void {
    const style = this.motto.settings.headerStyles[mode];
    const disabled = () => this.motto.settings.headerDisplay === 'none';
    this.createSetting(parent, 'Header background', disabled, mode)
      .setDesc('Based on the code block background; the code itself is not changed.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({
          code: 'Same as code block', darker: 'Slightly darker', lighter: 'Slightly lighter', custom: 'Custom color',
        }).setValue(style.background).onChange(async (value) => {
          if (!isChoice(value, HEADER_BACKGROUNDS)) return this.invalidChoice();
          await this.saveStyle(mode, { background: value }, refresh);
        });
      }).addExtraButton(this.resetStyleButton(mode, 'background', refresh));
    if (style.background === 'custom') {
      this.createSetting(parent, 'Custom background color', disabled, mode).addColorPicker((picker) => {
        picker.setValue(style.backgroundColor).onChange(async (value) => {
          await this.saveStyle(mode, { backgroundColor: value });
        });
      }).addExtraButton(this.resetStyleButton(mode, 'backgroundColor', refresh));
    }
  }

  private addTitle(parent: HTMLElement, mode: ColorMode, refresh: () => void): void {
    const style = this.motto.settings.headerStyles[mode];
    const disabled = () => this.motto.settings.headerDisplay === 'none';
    for (const [key, name] of [
      ['titleBold', 'Bold title'], ['titleItalic', 'Italic title'],
    ] as const) {
      this.createSetting(parent, name, disabled, mode).addToggle((toggle) => {
        toggle.setValue(style[key]).onChange(async (value) => { await this.saveStyle(mode, { [key]: value }); });
      }).addExtraButton(this.resetStyleButton(mode, key, refresh));
    }
    this.createSetting(parent, 'Title font size', disabled, mode)
      .setDesc('A positive whole number of pixels. Default: 14.').addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.step = '1';
        text.inputEl.setAttribute('aria-label', 'Title font size in pixels');
        text.setValue(String(style.titleFontSize));
        text.inputEl.addEventListener('change', async () => {
          const value = Number(text.getValue());
          if (!isPositiveInteger(value)) {
            new Notice('Motto Code Block: Enter a positive whole number of pixels.');
            text.setValue(String(this.motto.settings.headerStyles[mode].titleFontSize));
            return;
          }
          await this.saveStyle(mode, { titleFontSize: value });
        });
      }).addExtraButton(this.resetStyleButton(mode, 'titleFontSize', refresh));
    this.createSetting(parent, 'Override title color', disabled, mode).addToggle((toggle) => {
      toggle.setValue(style.overrideTitleColor).onChange(async (value) => {
        await this.saveStyle(mode, { overrideTitleColor: value }, refresh);
      });
    }).addExtraButton(this.resetStyleButton(mode, 'overrideTitleColor', refresh));
    if (style.overrideTitleColor) {
      this.createSetting(parent, 'Custom title color', disabled, mode).addColorPicker((picker) => {
        picker.setValue(style.titleColor).onChange(async (value) => {
          await this.saveStyle(mode, { titleColor: value });
        });
      }).addExtraButton(this.resetStyleButton(mode, 'titleColor', refresh));
    }
  }

  private addOutputToggleAppearance(parent: HTMLElement, mode: ColorMode, refresh: () => void): void {
    const style = this.motto.settings.outputToggleStyles[mode];
    const disabled = () => !this.motto.settings.commandBlocks;
    this.createSetting(parent, 'Output toggle icon', disabled, mode)
      .setDesc('Choose the icon pair used to show and hide output.').addDropdown((dropdown) => {
        dropdown.addOptions({
          eye: 'Eye', monitor: 'Monitor', expand: 'Expand / collapse', book: 'Book', chevron: 'Up / down chevrons',
          hippo: 'Hippo',
        }).setValue(style.icon).onChange(async (value) => {
          if (!isChoice(value, OUTPUT_TOGGLE_ICONS)) return this.invalidChoice();
          await this.saveOutputToggleStyle(mode, { icon: value });
        });
      }).addExtraButton(this.resetOutputToggleStyleButton(mode, 'icon', refresh));
    this.createSetting(parent, 'Reverse output toggle icons', disabled, mode)
      .setDesc('Swap the show/hide icons for this color mode. Does not change output visibility.').addToggle((toggle) => {
        toggle.setValue(style.reverseIcons).onChange(async (value) => {
          await this.saveOutputToggleStyle(mode, { reverseIcons: value });
        });
      }).addExtraButton(this.resetOutputToggleStyleButton(mode, 'reverseIcons', refresh));
    this.createSetting(parent, 'Override output toggle color', disabled, mode)
      .setDesc('Off: automatic, matching the adjacent copy button.').addToggle((toggle) => {
        toggle.setValue(style.overrideColor).onChange(async (value) => {
          await this.saveOutputToggleStyle(mode, { overrideColor: value }, refresh);
        });
      }).addExtraButton(this.resetOutputToggleStyleButton(mode, 'overrideColor', refresh));
    if (style.overrideColor) {
      this.createSetting(parent, 'Output toggle color', disabled, mode).addColorPicker((picker) => {
        picker.setValue(style.color).onChange(async (value) => {
          await this.saveOutputToggleStyle(mode, { color: value });
        });
      }).addExtraButton(this.resetOutputToggleStyleButton(mode, 'color', refresh));
    }
  }

  private resetStyleButton(
    mode: ColorMode, key: keyof HeaderStyleSettings, refresh: () => void,
  ): (button: ExtraButtonComponent) => void {
    return this.resetButton(
      () => this.saveStyle(mode, { [key]: DEFAULT_SETTINGS.headerStyles[mode][key] }, refresh),
      () => this.motto.settings.headerStyles[mode][key] !== DEFAULT_SETTINGS.headerStyles[mode][key],
    );
  }

  private resetOutputToggleStyleButton(
    mode: ColorMode, key: keyof OutputToggleStyleSettings, refresh: () => void,
  ): (button: ExtraButtonComponent) => void {
    return this.resetButton(
      () => this.saveOutputToggleStyle(mode, { [key]: DEFAULT_SETTINGS.outputToggleStyles[mode][key] }, refresh),
      () => this.motto.settings.outputToggleStyles[mode][key] !== DEFAULT_SETTINGS.outputToggleStyles[mode][key],
    );
  }

  private resetButton(reset: () => Promise<void>, modified: () => boolean): (button: ExtraButtonComponent) => void {
    return (button) => {
      button.setIcon('rotate-ccw').setTooltip('Restore default').onClick(reset);
      this.resetButtons.set(button.extraSettingsEl, modified);
    };
  }

  private saveStyle(mode: ColorMode, patch: Partial<HeaderStyleSettings>, refresh?: () => void): Promise<void> {
    return this.save((settings) => ({
      ...settings, headerStyles: { ...settings.headerStyles, [mode]: { ...settings.headerStyles[mode], ...patch } },
    }), refresh);
  }

  private saveOutputToggleStyle(
    mode: ColorMode, patch: Partial<OutputToggleStyleSettings>, refresh?: () => void,
  ): Promise<void> {
    return this.save((settings) => ({
      ...settings, outputToggleStyles: { ...settings.outputToggleStyles, [mode]: { ...settings.outputToggleStyles[mode], ...patch } },
    }), refresh);
  }

  private save(change: (settings: MottoSettings) => MottoSettings, refresh?: () => void): Promise<void> {
    this.saveQueue = this.saveQueue.then(async () => {
      const previous = this.motto.settings;
      this.motto.settings = change(previous);
      try {
        await this.motto.saveSettings();
      } catch (error) {
        this.motto.settings = previous;
        console.error('[Motto Code Block] Failed to save settings.', error);
        new Notice('Motto Code Block: Failed to save settings.');
        this.preserveContext(() => { this.render(); });
        return;
      }
      refresh?.();
      this.updateControlStates();
    });
    return this.saveQueue;
  }

  private invalidChoice(): void {
    console.error('[Motto Code Block] Invalid setting choice.');
    new Notice('Motto Code Block: Invalid setting choice.');
    this.preserveContext(() => { this.render(); });
  }
}
