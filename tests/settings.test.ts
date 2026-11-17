import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, isLanguageEnabled, OUTPUT_TOGGLE_ICONS, parseSettings } from '../src/settings';

afterEach(() => { vi.restoreAllMocks(); });

describe('saved settings', () => {
  it('normalizes and round-trips language lists with blacklist precedence and exact alias matching', () => {
    const settings = parseSettings({
      languageWhitelist: [' JS ', 'javascript', 'PY', 'js', ' plaintext '],
      languageBlacklist: [' js ', 'PLAINTEXT', 'js'],
    });
    expect(settings.languageWhitelist).toEqual(['js', 'javascript', 'py', 'plaintext']);
    expect(settings.languageBlacklist).toEqual(['js', 'plaintext']);
    expect(isLanguageEnabled('JS', settings)).toBe(false);
    expect(isLanguageEnabled('JavaScript', settings)).toBe(true);
    expect(isLanguageEnabled('py', settings)).toBe(true);
    expect(isLanguageEnabled('python', settings)).toBe(false);
    expect(isLanguageEnabled('', settings)).toBe(false);
    settings.languageBlacklist = [];
    expect(isLanguageEnabled('', settings)).toBe(true);
    settings.languageWhitelist = [];
    expect(isLanguageEnabled('javascript', settings)).toBe(false);
    expect(isLanguageEnabled('', settings)).toBe(false);
    expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it('enables ordinary CC language names and supported command languages by default, not plugin renderers', () => {
    const settings = parseSettings({ showIcon: false });
    for (const language of ['js', 'javascript', 'py', 'python', 'cpp', 'sh', 'bash', 'zsh', 'csh', 'fish', 'ansi', '']) {
      expect(isLanguageEnabled(language, settings), language).toBe(true);
    }
    for (const language of ['mermaid', 'dataview', 'dataviewjs', 'ad-note', 'unknown-plugin']) {
      expect(isLanguageEnabled(language, settings), language).toBe(false);
    }
    settings.languageWhitelist.length = 0;
    settings.languageBlacklist.length = 0;
    expect(isLanguageEnabled('python', parseSettings(null))).toBe(true);
    expect(isLanguageEnabled('mermaid', parseSettings(null))).toBe(false);
  });

  it('reports invalid saved language lists and preserves their defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const value of ['js,py', null, ['js', 1]]) {
      expect(parseSettings({ languageWhitelist: value, languageBlacklist: value })).toEqual(DEFAULT_SETTINGS);
    }
    for (const key of ['languageWhitelist', 'languageBlacklist']) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"${key}"`));
    }
  });

  it('keeps header copying off for existing settings and round-trips an explicit choice', () => {
    expect(parseSettings({ showLanguage: false }).showHeaderCopyButton).toBe(false);
    for (const showHeaderCopyButton of [true, false]) {
      const settings = parseSettings({ showHeaderCopyButton });
      expect(settings.showHeaderCopyButton).toBe(showHeaderCopyButton);
      expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    }
  });

  it('round-trips every output icon and independent light/dark colors without sharing defaults', () => {
    for (const icon of OUTPUT_TOGGLE_ICONS) {
      const settings = parseSettings({
        outputToggleStyles: {
          light: { icon, reverseIcons: true, overrideColor: true, color: '#12ab34' },
          dark: { icon: 'book', overrideColor: false, color: '#abcdef' },
        },
      });
      expect(settings.outputToggleStyles.light).toEqual({ icon, reverseIcons: true, overrideColor: true, color: '#12ab34' });
      expect(settings.outputToggleStyles.dark).toEqual({
        icon: 'book', reverseIcons: false, overrideColor: false, color: '#abcdef',
      });
      expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    }
    const fresh = parseSettings({ showIcon: false });
    expect(fresh.outputToggleStyles).toEqual(DEFAULT_SETTINGS.outputToggleStyles);
    fresh.outputToggleStyles.light.icon = 'monitor';
    expect(fresh.outputToggleStyles.dark.icon).toBe('eye');
    expect(DEFAULT_SETTINGS.outputToggleStyles.light.icon).toBe('eye');
  });

  it('reports invalid output styles while preserving valid fields and the other theme', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = parseSettings({
      outputToggleStyles: {
        light: { icon: 'missing', reverseIcons: 'true', overrideColor: 'false', color: '#fff; color:red' },
        dark: { icon: 'monitor', overrideColor: true, color: '#abcdef' },
      },
    });
    expect(settings.outputToggleStyles.light).toEqual(DEFAULT_SETTINGS.outputToggleStyles.light);
    expect(settings.outputToggleStyles.dark).toEqual({
      icon: 'monitor', reverseIcons: false, overrideColor: true, color: '#abcdef',
    });
    for (const field of ['icon', 'reverseIcons', 'overrideColor', 'color']) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`outputToggleStyles.light.${field}`));
    }
    expect(parseSettings({ outputToggleStyles: [] })).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"outputToggleStyles"'));
    expect(parseSettings({ outputToggleStyles: { dark: null } })).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"outputToggleStyles.dark"'));
  });

  it('persists command opt-out and reports invalid values', () => {
    const settings = parseSettings({ commandBlocks: false });
    expect(settings.commandBlocks).toBe(false);
    expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSettings({ commandBlocks: 'false' }).commandBlocks).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"commandBlocks"'));
  });

  it('keeps defaults for new settings while preserving saved feature choices', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ showIcon: false })).toEqual({ ...DEFAULT_SETTINGS, showIcon: false });
    expect(parseSettings({ showHeader: false }).lineNumbers).toBe('default');
  });

  it('migrates the previous line-number toggle while preferring the new setting', () => {
    expect(parseSettings({ showLineNumbers: true }).lineNumbers).toBe('default');
    expect(parseSettings({ showLineNumbers: false }).lineNumbers).toBe('none');
    expect(parseSettings({ showLineNumbers: false, lineNumbers: 'always' }).lineNumbers).toBe('always');
  });

  it('migrates the old header toggle to Default or None while preferring the new mode', () => {
    expect(parseSettings({ showHeader: true }).headerDisplay).toBe('default');
    expect(parseSettings({ showHeader: false }).headerDisplay).toBe('none');
    expect(parseSettings({ showHeader: false, headerDisplay: 'always' }).headerDisplay).toBe('always');
  });

  it.each(['default', 'always', 'none'])('round-trips the %s header display mode', (headerDisplay) => {
    const settings = parseSettings({ headerDisplay });
    expect(settings.headerDisplay).toBe(headerDisplay);
    expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it.each(['default', 'always', 'none'])('round-trips the %s line-number mode', (lineNumbers) => {
    const settings = parseSettings({ lineNumbers });
    expect(settings.lineNumbers).toBe(lineNumbers);
    expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it.each(['folded', 'expanded', 'partial'])('round-trips the %s default fold state', (defaultFoldState) => {
    const settings = parseSettings({ defaultFoldState, partialFoldLines: 3 });
    expect(settings.defaultFoldState).toBe(defaultFoldState);
    expect(settings.partialFoldLines).toBe(3);
    expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it.each([0, -1, 1.5, Infinity, '5'])('reports invalid partial preview lengths: %j', (partialFoldLines) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSettings({ partialFoldLines })).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"partialFoldLines"'));
  });

  it('reports invalid saved values instead of treating strings as booleans', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSettings({
      showIcon: 'false', showLanguage: false, showHeaderCopyButton: 'true',
      headerDisplay: 'invalid', lineNumbers: 'false', defaultFoldState: true,
    })).toEqual({
      ...DEFAULT_SETTINGS, showLanguage: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"showIcon"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"showHeaderCopyButton"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"headerDisplay"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"lineNumbers"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"defaultFoldState"'));
    expect(parseSettings({ showLineNumbers: 'false' })).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"showLineNumbers"'));
    expect(parseSettings({ showHeader: 'false' })).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"showHeader"'));
    expect(parseSettings([])).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid saved settings'));
  });

  it('round-trips independent light and dark header styles', () => {
    const saved = {
      showIcon: false,
      headerStyles: {
        light: {
          background: 'darker', iconSize: 'large', titleBold: true, titleItalic: true,
          titleFontSize: 20, overrideTitleColor: true, titleColor: '#123abc', languageLabel: 'emphasized',
        },
        dark: { background: 'custom', backgroundColor: '#283747', iconSize: 'small', titleFontSize: 12 },
      },
    };
    const settings = parseSettings(saved);
    expect(settings.headerStyles.light).toMatchObject(saved.headerStyles.light);
    expect(settings.headerStyles.dark).toMatchObject(saved.headerStyles.dark);
    expect(settings.showIcon).toBe(false);
    expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    const fresh = parseSettings(null);
    fresh.headerStyles.light.titleBold = true;
    expect(fresh.headerStyles.dark.titleBold).toBe(false);
    expect(DEFAULT_SETTINGS.headerStyles.light.titleBold).toBe(false);
  });

  it('reports invalid appearance fields while preserving valid fields and the other mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = parseSettings({
      headerStyles: {
        light: {
          background: 'invalid', backgroundColor: 'url(https://example.com/image)',
          iconSize: 'huge', titleBold: 'true', titleItalic: true, titleFontSize: 0,
          titleColor: '#fff; color:red', languageLabel: 'other',
        },
        dark: { titleFontSize: 18 },
      },
    });
    expect(settings.headerStyles.light).toEqual({ ...DEFAULT_SETTINGS.headerStyles.light, titleItalic: true });
    expect(settings.headerStyles.dark.titleFontSize).toBe(18);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('headerStyles.light.backgroundColor'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('headerStyles.light.titleFontSize'));
    expect(parseSettings({ headerStyles: [] })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ headerStyles: { dark: null } })).toEqual(DEFAULT_SETTINGS);
  });

  it.each([-1, 1.5, Infinity, '18'])('rejects invalid title sizes: %s', (titleFontSize) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSettings({ headerStyles: { dark: { titleFontSize } } }).headerStyles.dark.titleFontSize)
      .toBe(DEFAULT_SETTINGS.headerStyles.dark.titleFontSize);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('headerStyles.dark.titleFontSize'));
  });
});
