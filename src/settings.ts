export const COLOR_MODES = ['light', 'dark'] as const;
export const HEADER_BACKGROUNDS = ['code', 'darker', 'lighter', 'custom'] as const;
export const ICON_SIZES = ['large', 'medium', 'small'] as const;
export const LANGUAGE_LABEL_STYLES = ['default', 'emphasized'] as const;
export const HEADER_DISPLAY_MODES = ['default', 'always', 'none'] as const;
export const LINE_NUMBER_MODES = ['default', 'always', 'none'] as const;
export const FOLD_STATES = ['expanded', 'folded', 'partial'] as const;
export const OUTPUT_TOGGLE_ICONS = ['eye', 'monitor', 'expand', 'book', 'chevron', 'hippo'] as const;

export type ColorMode = typeof COLOR_MODES[number];
export type HeaderDisplayMode = typeof HEADER_DISPLAY_MODES[number];
export type LineNumberMode = typeof LINE_NUMBER_MODES[number];
export type FoldState = typeof FOLD_STATES[number];
export type OutputToggleIcon = typeof OUTPUT_TOGGLE_ICONS[number];

export interface OutputToggleStyleSettings {
  icon: OutputToggleIcon;
  reverseIcons: boolean;
  overrideColor: boolean;
  color: string;
}

export interface HeaderStyleSettings {
  background: typeof HEADER_BACKGROUNDS[number];
  backgroundColor: string;
  iconSize: typeof ICON_SIZES[number];
  titleBold: boolean;
  titleItalic: boolean;
  titleFontSize: number;
  overrideTitleColor: boolean;
  titleColor: string;
  languageLabel: typeof LANGUAGE_LABEL_STYLES[number];
}

export interface MottoSettings {
  languageWhitelist: string[];
  languageBlacklist: string[];
  headerDisplay: HeaderDisplayMode;
  commandBlocks: boolean;
  showIcon: boolean;
  showLanguage: boolean;
  showHeaderCopyButton: boolean;
  lineNumbers: LineNumberMode;
  defaultFoldState: FoldState;
  partialFoldLines: number;
  headerStyles: Record<ColorMode, HeaderStyleSettings>;
  outputToggleStyles: Record<ColorMode, OutputToggleStyleSettings>;
}

const DEFAULT_HEADER_STYLE: Readonly<HeaderStyleSettings> = {
  background: 'code',
  backgroundColor: '#eeeeee',
  iconSize: 'medium',
  titleBold: false,
  titleItalic: false,
  titleFontSize: 14,
  overrideTitleColor: false,
  titleColor: '#222222',
  languageLabel: 'default',
};

export const DEFAULT_SETTINGS: Readonly<MottoSettings> = {
  languageWhitelist: normalizeLanguageList([
    ...Object.entries(languages).flatMap(([id, definition]) => [id, ...definition.aliases]),
    ...SHELL_LANGUAGES, 'ansi',
  ].join('\n')).sort(),
  languageBlacklist: ['mermaid'],
  headerDisplay: 'default',
  commandBlocks: true,
  showIcon: true,
  showLanguage: true,
  showHeaderCopyButton: false,
  lineNumbers: 'default',
  defaultFoldState: 'expanded',
  partialFoldLines: 5,
  headerStyles: {
    light: { ...DEFAULT_HEADER_STYLE },
    dark: { ...DEFAULT_HEADER_STYLE, backgroundColor: '#303030', titleColor: '#eeeeee' },
  },
  outputToggleStyles: {
    light: { icon: 'eye', reverseIcons: false, overrideColor: false, color: '#222222' },
    dark: { icon: 'eye', reverseIcons: false, overrideColor: false, color: '#eeeeee' },
  },
};

export function normalizeLanguageList(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[,\s]+/).filter(Boolean))];
}

export function isLanguageEnabled(
  language: string,
  settings: Pick<MottoSettings, 'languageWhitelist' | 'languageBlacklist'>,
): boolean {
  const name = language.trim().toLowerCase() || 'plaintext';
  return settings.languageWhitelist.includes(name) && !settings.languageBlacklist.includes(name);
}

export function isChoice<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return choices.some((choice) => choice === value);
}

export function shouldShowHeader(mode: HeaderDisplayMode, hasParameters: boolean): boolean {
  return mode === 'always' || (mode === 'default' && hasParameters);
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
}

function parseOutputToggleStyle(data: unknown, mode: ColorMode): OutputToggleStyleSettings {
  const style = { ...DEFAULT_SETTINGS.outputToggleStyles[mode] };
  if (!isRecord(data)) {
    console.warn(`[Motto Codeblock] Invalid setting "outputToggleStyles.${mode}"; using defaults.`);
    return style;
  }
  for (const key of Object.keys(style) as (keyof OutputToggleStyleSettings)[]) {
    if (!(key in data)) continue;
    const value = data[key];
    switch (key) {
      case 'icon':
        if (isChoice(value, OUTPUT_TOGGLE_ICONS)) { style[key] = value; continue; }
        break;
      case 'reverseIcons':
      case 'overrideColor':
        if (typeof value === 'boolean') { style[key] = value; continue; }
        break;
      case 'color':
        if (isHexColor(value)) { style[key] = value; continue; }
        break;
    }
    console.warn(`[Motto Codeblock] Invalid setting "outputToggleStyles.${mode}.${key}"; using its default.`);
  }
  return style;
}

function parseHeaderStyle(data: unknown, mode: ColorMode): HeaderStyleSettings {
  const style = { ...DEFAULT_SETTINGS.headerStyles[mode] };
  if (!isRecord(data)) {
    console.warn(`[Motto Codeblock] Invalid setting "headerStyles.${mode}"; using defaults.`);
    return style;
  }
  for (const key of Object.keys(style) as (keyof HeaderStyleSettings)[]) {
    if (!(key in data)) continue;
    const value = data[key];
    switch (key) {
      case 'background':
        if (isChoice(value, HEADER_BACKGROUNDS)) { style[key] = value; continue; }
        break;
      case 'iconSize':
        if (isChoice(value, ICON_SIZES)) { style[key] = value; continue; }
        break;
      case 'languageLabel':
        if (isChoice(value, LANGUAGE_LABEL_STYLES)) { style[key] = value; continue; }
        break;
      case 'titleBold':
      case 'titleItalic':
      case 'overrideTitleColor':
        if (typeof value === 'boolean') { style[key] = value; continue; }
        break;
      case 'titleFontSize':
        if (isPositiveInteger(value)) { style[key] = value; continue; }
        break;
      case 'backgroundColor':
      case 'titleColor':
        if (isHexColor(value)) { style[key] = value; continue; }
        break;
    }
    console.warn(`[Motto Codeblock] Invalid setting "headerStyles.${mode}.${key}"; using its default.`);
  }
  return style;
}

export function parseSettings(data: unknown): MottoSettings {
  const settings: MottoSettings = {
    ...DEFAULT_SETTINGS,
    languageWhitelist: [...DEFAULT_SETTINGS.languageWhitelist],
    languageBlacklist: [...DEFAULT_SETTINGS.languageBlacklist],
    headerStyles: {
      light: { ...DEFAULT_SETTINGS.headerStyles.light },
      dark: { ...DEFAULT_SETTINGS.headerStyles.dark },
    },
    outputToggleStyles: {
      light: { ...DEFAULT_SETTINGS.outputToggleStyles.light },
      dark: { ...DEFAULT_SETTINGS.outputToggleStyles.dark },
    },
  };
  if (data === null || data === undefined) return settings;
  if (!isRecord(data)) {
    console.warn('[Motto Codeblock] Invalid saved settings; using defaults.');
    return settings;
  }
  for (const key of ['languageWhitelist', 'languageBlacklist'] as const) {
    if (!(key in data)) continue;
    const value: unknown = data[key];
    if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) {
      settings[key] = normalizeLanguageList(value.join('\n'));
    } else console.warn(`[Motto Codeblock] Invalid setting "${key}"; using its default.`);
  }
  for (const key of ['commandBlocks', 'showIcon', 'showLanguage', 'showHeaderCopyButton'] as const) {
    if (!(key in data)) continue;
    const value: unknown = Reflect.get(data, key);
    if (typeof value === 'boolean') settings[key] = value;
    else console.warn(`[Motto Codeblock] Invalid setting "${key}"; using its default.`);
  }
  if ('headerDisplay' in data) {
    if (isChoice(data.headerDisplay, HEADER_DISPLAY_MODES)) settings.headerDisplay = data.headerDisplay;
    else console.warn('[Motto Codeblock] Invalid setting "headerDisplay"; using its default.');
  } else if ('showHeader' in data) {
    if (typeof data.showHeader === 'boolean') settings.headerDisplay = data.showHeader ? 'default' : 'none';
    else console.warn('[Motto Codeblock] Invalid setting "showHeader"; using its default.');
  }
  if ('lineNumbers' in data) {
    if (isChoice(data.lineNumbers, LINE_NUMBER_MODES)) settings.lineNumbers = data.lineNumbers;
    else console.warn('[Motto Codeblock] Invalid setting "lineNumbers"; using its default.');
  } else if ('showLineNumbers' in data) {
    if (typeof data.showLineNumbers === 'boolean') settings.lineNumbers = data.showLineNumbers ? 'default' : 'none';
    else console.warn('[Motto Codeblock] Invalid setting "showLineNumbers"; using its default.');
  }
  if ('defaultFoldState' in data) {
    if (isChoice(data.defaultFoldState, FOLD_STATES)) settings.defaultFoldState = data.defaultFoldState;
    else console.warn('[Motto Codeblock] Invalid setting "defaultFoldState"; using its default.');
  }
  if ('partialFoldLines' in data) {
    if (isPositiveInteger(data.partialFoldLines)) settings.partialFoldLines = data.partialFoldLines;
    else console.warn('[Motto Codeblock] Invalid setting "partialFoldLines"; using its default.');
  }
  if ('headerStyles' in data) {
    if (!isRecord(data.headerStyles)) {
      console.warn('[Motto Codeblock] Invalid setting "headerStyles"; using defaults.');
    } else {
      for (const mode of COLOR_MODES) {
        if (mode in data.headerStyles) settings.headerStyles[mode] = parseHeaderStyle(data.headerStyles[mode], mode);
      }
    }
  }
  if ('outputToggleStyles' in data) {
    if (!isRecord(data.outputToggleStyles)) {
      console.warn('[Motto Codeblock] Invalid setting "outputToggleStyles"; using defaults.');
    } else {
      for (const mode of COLOR_MODES) {
        if (mode in data.outputToggleStyles) {
          settings.outputToggleStyles[mode] = parseOutputToggleStyle(data.outputToggleStyles[mode], mode);
        }
      }
    }
  }
  return settings;
}
import { SHELL_LANGUAGES } from './commands';
import { languages } from './languages';

