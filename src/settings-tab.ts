import {
  Notice, PluginSettingTab, Setting, requireApiVersion, setTooltip,
  type App, type ExtraButtonComponent, type SettingDefinitionItem, type SettingDefinitionRender,
} from 'obsidian';
import type MottoCodeBlockPlugin from './main';
import { createEl } from './dom';
import { compilePromptPatterns, type TerminalPromptPattern } from './terminal-prompt';
import {
  COLOR_MODES, COMMAND_SPACING_MODES, DEFAULT_SETTINGS, FOLD_STATES, HEADER_BACKGROUNDS, HEADER_DISPLAY_MODES,
  ICON_SIZES, LANGUAGE_LABEL_STYLES, LINE_NUMBER_MODES, OUTPUT_TOGGLE_ICONS,
  isChoice, isPositiveInteger, normalizeLanguageList,
  type ColorMode, type HeaderStyleSettings, type MottoSettings, type OutputToggleStyleSettings,
} from './settings';

type ChoiceKey = 'headerDisplay' | 'lineNumbers' | 'defaultFoldState' | 'commandSpacing';
type ThemeRenderer = (parent: HTMLElement, mode: ColorMode, refresh: () => void) => void;

export class MottoSettingsTab extends PluginSettingTab {
  private readonly motto: MottoCodeBlockPlugin;
  private colorMode: ColorMode = 'light';
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly themeRefreshers: (() => void)[] = [];
  private readonly disabledSettings = new Map<Setting, () => boolean>();
  private readonly resetButtons = new Map<HTMLElement, () => boolean>();
  private declarative = false;
  private opening = true;

  constructor(app: App, motto: MottoCodeBlockPlugin) {
    super(app, motto);
    this.motto = motto;
    this.containerEl.classList.add('motto-settings');
  }

  override display(): void {
    this.declarative = false;
    this.opening = false;
    this.colorMode = this.containerEl.ownerDocument.body.classList.contains('theme-dark') ? 'dark' : 'light';
    this.render();
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.customSettings('Editing theme', ['Light', 'Dark'], (parent) => this.addThemeSelector(parent)),
      {
        type: 'group', heading: 'General', cls: 'motto-settings-section motto-settings-level-2',
        items: [this.customSettings('Language eligibility', ['Language include list', 'Language exclude list'],
          (parent) => this.addLanguages(parent))],
      },
      {
        type: 'group', heading: 'Code blocks', cls: 'motto-settings-section motto-settings-level-2',
        items: [
          this.customSettings('Header', [
            'Header display', 'Show header copy button', 'Show icon', 'Icon size', 'Show language label',
            'Language label style', 'Header background', 'Custom background color', 'Title',
            'Bold title', 'Italic title', 'Title font size', 'Override title color', 'Custom title color',
          ], (parent) => this.addHeader(parent)),
          this.customSettings('Body', ['Line numbers'], (parent) => this.addBody(parent)),
          this.customSettings('Folding', ['Default fold state', 'Partial preview lines'],
            (parent) => this.addFolding(parent)),
        ],
      },
      {
        type: 'group', heading: 'Command blocks', cls: 'motto-settings-section motto-settings-level-2',
        items: [
          this.customSettings('Command blocks', [
            'Command languages', 'Color inline prompts', 'Command spacing',
            'Terminal prompt patterns', 'Ignored terminal command suffixes',
          ], (parent) => this.addCommands(parent)),
          this.customSettings('Output', [
            'Output languages', 'Output toggle icon', 'Reverse output toggle icons',
            'Override output toggle color', 'Output toggle color', 'Tap my hip-po!',
          ], (parent) => this.addOutput(parent)),
        ],
      },
    ];
  }

  override hide(): void {
    this.opening = true;
    this.themeRefreshers.length = 0;
    this.disabledSettings.clear();
    this.resetButtons.clear();
    super.hide();
  }

  private customSettings(
    name: string, aliases: string[], render: (parent: HTMLElement) => void,
  ): SettingDefinitionRender {
    return {
      name, aliases,
      render: (setting) => {
        this.declarative = true;
        if (this.opening) {
          this.colorMode = this.containerEl.ownerDocument.body.classList.contains('theme-dark') ? 'dark' : 'light';
          this.opening = false;
        }
        const host = setting.settingEl;
        host.replaceChildren();
        host.classList.add('motto-settings-host');
        const start = this.themeRefreshers.length;
        render(host);
        const refreshers = this.themeRefreshers.slice(start);
        this.updateControlStates();
        return () => {
          for (const refresh of refreshers) {
            const index = this.themeRefreshers.indexOf(refresh);
            if (index >= 0) this.themeRefreshers.splice(index, 1);
          }
          for (const control of this.disabledSettings.keys()) {
            if (host.contains(control.settingEl)) this.disabledSettings.delete(control);
          }
          for (const element of this.resetButtons.keys()) {
            if (host.contains(element)) this.resetButtons.delete(element);
          }
        };
      },
    };
  }

  private render(): void {
    if (requireApiVersion('1.13.0') && this.declarative) {
      this.update();
      return;
    }
    this.declarative = false;
    this.containerEl.empty();
    this.themeRefreshers.length = 0;
    this.disabledSettings.clear();
    this.resetButtons.clear();
    this.addThemeSelector();

    this.addLanguages(this.section(this.containerEl, 'General', 2));
    const blocks = this.section(this.containerEl, 'Code blocks', 2);
    this.addHeader(blocks);
    this.addBody(blocks);
    this.addFolding(blocks);
    const commands = this.section(this.containerEl, 'Command blocks', 2);
    this.addCommands(commands);
    this.addOutput(commands);
    this.updateControlStates();
  }

  private addLanguages(parent: HTMLElement): void {
    const languages = this.section(parent, 'Language eligibility', 3);
    this.addLanguageList(languages, 'languageIncludeList', 'Language include list',
      'Fence languages eligible for ordinary code block enhancements and output. Command languages are configured separately. Separate with commas, spaces or new lines; case-insensitive, exact names only. Aliases are separate entries. Use plaintext for unlabelled blocks.');
    this.addLanguageList(languages, 'languageExcludeList', 'Language exclude list',
      'Never enhance these fence names, even when present in the include or command languages list. Same format as the include list. Mermaid is excluded by default to preserve native rendering.');

  }

  private addHeader(parent: HTMLElement): void {
    const header = this.section(parent, 'Header', 3);
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
  }

  private addBody(parent: HTMLElement): void {
    const body = this.section(parent, 'Body', 3);
    this.addChoice(body, 'lineNumbers', 'Line numbers',
      'Default: show for two or more lines. Always: show for every block. None: hide. Command rows and paired output are not numbered.',
      LINE_NUMBER_MODES, { default: 'Default', always: 'Always', none: 'None' });
  }

  private addFolding(parent: HTMLElement): void {
    const folding = this.section(parent, 'Folding', 3);
    this.addChoice(folding, 'defaultFoldState', 'Default fold state',
      'Initial body state when fold, expand or unfold is not specified. Explicit options take precedence. Does not set paired output visibility.',
      FOLD_STATES, { expanded: 'Expanded', folded: 'Folded', partial: 'Partial preview' });
    this.addPreviewLines(folding);
  }

  private addCommands(commands: HTMLElement): void {
    const noCommands = () => !this.motto.settings.commandBlocks;
    this.addToggle(commands, 'commandBlocks', 'Command blocks',
      'Enhance configured languages when marked cmd/command, containing execution metadata, or immediately followed by a configured output block. Standalone ANSI rendering is independent.');
    this.addLanguageList(commands, 'commandLanguages', 'Command languages',
      'Add fence languages such as dash without changing the general include list. The exclude list and exclude flag still apply. Separate with commas, spaces or new lines; case-insensitive, exact names only. Empty disables command blocks.',
      noCommands);
    this.addThemeGroup(commands, (parent, mode, refresh) => this.addPromptColor(parent, mode, refresh));
    this.addChoice(commands, 'commandSpacing', 'Command spacing',
      'Vertical spacing between commands in the same block. Small keeps the original spacing; Middle is the default. Continued lines are unchanged.',
      COMMAND_SPACING_MODES, { small: 'Small', middle: 'Middle', large: 'Large' }, noCommands);
    this.addTerminalPromptPatterns(commands);
    this.addIgnoredTerminalCommandSuffixes(commands);
  }

  private addPromptColor(parent: HTMLElement, mode: ColorMode, refresh: () => void): void {
    const update = (value: boolean, afterSave?: () => void) => this.save((settings) => ({
      ...settings, colorInlinePrompts: { ...settings.colorInlinePrompts, [mode]: value },
    }), afterSave);
    this.createSetting(parent, 'Color inline prompts', () => !this.motto.settings.commandBlocks, mode)
      .setDesc('Use theme colors for the text before the prompt symbol. Turn off to use the same color as the symbol.')
      .addToggle((toggle) => {
        toggle.setValue(this.motto.settings.colorInlinePrompts[mode]).onChange((value) => update(value));
      })
      .addExtraButton(this.resetButton(
        () => update(DEFAULT_SETTINGS.colorInlinePrompts[mode], refresh),
        () => this.motto.settings.colorInlinePrompts[mode] !== DEFAULT_SETTINGS.colorInlinePrompts[mode],
      ));
  }

  private addTerminalPromptPatterns(parent: HTMLElement): void {
    const heading = this.createSetting(parent, 'Terminal prompt patterns').setDesc(
      'Used when pasting terminal output. Enter a JavaScript regular expression without / delimiters. Match from the start through the final $, #, % or >, excluding the following space. Custom patterns are tried before presets. Automatic detection still runs if no enabled pattern matches.');
    const list = parent.createDiv();
    const renderPattern = (pattern: TerminalPromptPattern) => {
      const label = pattern.name ?? `Custom pattern ${pattern.id.replace(/^custom-/, '')}`;
      const row = new Setting(list).setName(label);
      row.settingEl.classList.add('motto-prompt-pattern');
      const update = (patch: Partial<Pick<TerminalPromptPattern, 'source' | 'enabled'>>) => this.save((settings) => ({
        ...settings, terminalPromptPatterns: settings.terminalPromptPatterns.map((entry) =>
          entry.id === pattern.id ? { ...entry, ...patch } : entry),
      }));
      row.addText((text) => {
        text.setValue(pattern.source);
        text.inputEl.readOnly = Boolean(pattern.name);
        text.inputEl.spellcheck = false;
        text.inputEl.setAttribute('aria-label', `${label} regular expression`);
        text.inputEl.addEventListener('change', () => {
          const source = text.getValue();
          const { invalid } = compilePromptPatterns([source]);
          if (invalid.length) {
            text.inputEl.setAttribute('aria-invalid', 'true');
            new Notice('Motto Code Block: Invalid terminal prompt pattern. The saved pattern was not changed.');
            return;
          }
          text.inputEl.removeAttribute('aria-invalid');
          void update({ source });
        });
      });
      row.addToggle((toggle) => {
        toggle.toggleEl.setAttribute('aria-label', `Enable ${label}`);
        toggle.setValue(pattern.enabled).onChange((enabled) => update({ enabled }));
      });
      if (!pattern.name) {
        const firstPreset = list.querySelector('.motto-prompt-preset');
        if (firstPreset) list.insertBefore(row.settingEl, firstPreset);
        row.addExtraButton((button) => {
          button.setIcon('trash-2').setTooltip(`Remove ${label}`).onClick(() => this.save((settings) => ({
            ...settings, terminalPromptPatterns: settings.terminalPromptPatterns.filter(({ id }) => id !== pattern.id),
          }), () => {
            if (row.settingEl.contains(row.settingEl.ownerDocument.activeElement)) {
              heading.controlEl.querySelector('button')?.focus();
            }
            row.settingEl.remove();
          }));
        });
      } else {
        row.settingEl.classList.add('motto-prompt-preset');
      }
      return row.settingEl.querySelector<HTMLInputElement>('input[type="text"]');
    };
    for (const pattern of this.motto.settings.terminalPromptPatterns) renderPattern(pattern);
    heading.addButton((button) => {
      button.setButtonText('Add pattern').onClick(() => {
        let added: TerminalPromptPattern;
        return this.save((settings) => {
          const ids = new Set(settings.terminalPromptPatterns.map(({ id }) => id));
          let number = 1;
          while (ids.has(`custom-${number}`)) number++;
          added = { id: `custom-${number}`, source: '', enabled: true };
          const patterns = [...settings.terminalPromptPatterns];
          const preset = patterns.findIndex(({ name }) => name);
          patterns.splice(preset === -1 ? patterns.length : preset, 0, added);
          return { ...settings, terminalPromptPatterns: patterns };
        }, () => {
          if (this.containerEl.contains(list)) renderPattern(added)?.focus();
        });
      });
    });
  }

  private addIgnoredTerminalCommandSuffixes(parent: HTMLElement): void {
    const name = 'Ignored terminal command suffixes';
    const setting = this.createSetting(parent, name).setDesc(
      'When pasting terminal output, skip commands ending in any of these literal strings and omit their associated output. Enter one per line. Default: ^C (Ctrl-C). Leave empty to keep all commands.');
    setting.controlEl.classList.add('motto-language-list-control');
    const key = 'terminalIgnoredCommandSuffixes';
    setting.addTextArea((text) => {
      text.inputEl.rows = 3;
      text.inputEl.cols = 36;
      text.inputEl.setAttribute('aria-label', name);
      text.setValue(this.motto.settings[key]);
      text.inputEl.addEventListener('change', () => {
        const value = text.getValue();
        void this.save((settings) => ({ ...settings, [key]: value }));
      });
      setting.addExtraButton(this.resetButton(() => this.save(
        (settings) => ({ ...settings, [key]: DEFAULT_SETTINGS[key] }),
        () => { text.setValue(this.motto.settings[key]); },
      ), () => this.motto.settings[key] !== DEFAULT_SETTINGS[key]));
    });
  }

  private addOutput(commands: HTMLElement): void {
    const noCommands = () => !this.motto.settings.commandBlocks;
    const output = this.section(commands, 'Output', 3);
    this.addLanguageList(output, 'outputLanguages', 'Output languages',
      'Fence languages treated as command output when immediately after a configured command block. Default: ansi and plaintext, which includes unlabelled blocks. Add text, json or xml as needed. Separate with commas, spaces or new lines; case-insensitive, exact names only. Language eligibility and exclude still apply. Empty disables output pairing.',
      noCommands);
    this.addThemeGroup(output, (parent, mode, refresh) => this.addOutputToggleAppearance(parent, mode, refresh));
    this.addToggle(output, 'tapMyHippo', 'Tap my hip-po!',
      'Let Hippo blocks and Hippo output toggles speak.');
  }

  private addThemeSelector(parent = this.containerEl): void {
    const setting = new Setting(parent).setName('Editing theme')
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
    const section = parent.createEl('section');
    section.className = `motto-settings-section motto-settings-level-${level}`;
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
    const marker = createEl(this.containerEl.ownerDocument, 'span');
    marker.className = 'motto-theme-setting-icon';
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', label);
    setTooltip(marker, label);
    const svg = marker.createSvg('svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const half = svg.createSvg('path');
    half.setAttribute('d', 'M12 3a9 9 0 0 0 0 18Z');
    half.setAttribute('fill', 'currentColor');
    const circle = svg.createSvg('circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '9');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2');
    return marker;
  }

  private addThemeGroup(parent: HTMLElement, render: ThemeRenderer): void {
    const group = parent.createDiv();
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
    parent: HTMLElement, key: 'languageIncludeList' | 'languageExcludeList' | 'commandLanguages' | 'outputLanguages',
    name: string, description: string, disabled: () => boolean = () => false,
  ): void {
    const setting = this.createSetting(parent, name, disabled).setDesc(description);
    const defaults = new Set(DEFAULT_SETTINGS[key]);
    setting.controlEl.classList.add('motto-language-list-control');
    setting.addTextArea((text) => {
      text.inputEl.rows = key === 'languageIncludeList' || key === 'commandLanguages' ? 6 : 3;
      text.inputEl.cols = 36;
      text.inputEl.setAttribute('aria-label', name);
      text.setValue(this.motto.settings[key].join('\n'));
      text.inputEl.addEventListener('change', () => {
        const value = normalizeLanguageList(text.getValue());
        void this.save((settings) => ({ ...settings, [key]: value }));
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
      text.inputEl.addEventListener('change', () => {
        const value = Number(text.getValue());
        if (!isPositiveInteger(value)) {
          new Notice('Motto Code Block: Enter a positive whole number of lines.');
          text.setValue(String(this.motto.settings.partialFoldLines));
          return;
        }
        void this.save((settings) => ({ ...settings, partialFoldLines: value }));
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
        text.inputEl.addEventListener('change', () => {
          const value = Number(text.getValue());
          if (!isPositiveInteger(value)) {
            new Notice('Motto Code Block: Enter a positive whole number of pixels.');
            text.setValue(String(this.motto.settings.headerStyles[mode].titleFontSize));
            return;
          }
          void this.saveStyle(mode, { titleFontSize: value });
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
