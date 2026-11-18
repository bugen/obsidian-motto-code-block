// @vitest-environment happy-dom
import { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MottoCodeblockPlugin from '../src/main';
import {
  COLOR_MODES, DEFAULT_SETTINGS, OUTPUT_TOGGLE_ICONS, parseSettings,
  type HeaderStyleSettings, type MottoSettings,
} from '../src/settings';
import { MottoSettingsTab } from '../src/settings-tab';
import { Notice } from './obsidian';

function fixture() {
  const app = new App();
  const plugin = new MottoCodeblockPlugin(app, {
    id: 'motto-codeblock', name: 'Motto Codeblock', version: '0.1.0',
    minAppVersion: '1.5.0', author: '', description: '',
  });
  const saved: MottoSettings[] = [];
  const save = vi.spyOn(plugin, 'saveSettings').mockImplementation(async () => {
    saved.push(parseSettings(plugin.settings));
  });
  const tab = new MottoSettingsTab(app, plugin);
  document.body.append(tab.containerEl);
  tab.display();
  function row(name: string) {
    const element = [...tab.containerEl.querySelectorAll<HTMLElement>('.setting-item')]
      .find((element) => element.querySelector('.setting-item-name')?.textContent === name);
    if (!element) throw new Error(`Missing setting: ${name}`);
    return element;
  }
  function change(name: string, value: string | boolean) {
    const select = row(name).querySelector('select');
    const input = row(name).querySelector('input');
    const textarea = row(name).querySelector('textarea');
    if (select && typeof value === 'string') {
      select.value = value;
      select.dispatchEvent(new Event('change'));
    } else if (input) {
      if (typeof value === 'boolean') input.checked = value;
      else input.value = value;
      input.dispatchEvent(new Event(input.type === 'color' ? 'input' : 'change'));
    } else if (textarea && typeof value === 'string') {
      textarea.value = value;
      textarea.dispatchEvent(new Event('change'));
    } else throw new Error(`Missing control: ${name}`);
  }
  function reset(name: string) {
    const button = row(name).querySelector<HTMLButtonElement>('button[aria-label="Restore default"]');
    if (!button) throw new Error(`Missing reset button: ${name}`);
    button.click();
  }
  return { plugin, tab, save, saved, row, change, reset };
}

afterEach(() => {
  vi.restoreAllMocks();
  Notice.messages.length = 0;
  document.body.replaceChildren();
  document.body.className = '';
});

describe('header appearance settings tab', () => {
  it('saves and resets output languages independently of language eligibility', async () => {
    const { plugin, saved, row, change, reset } = fixture();
    expect(row('Output languages').querySelector('textarea')?.value).toBe('ansi');
    change('Output languages', 'ANSI, Text\nJSON xml json');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual({
        ...DEFAULT_SETTINGS, outputLanguages: ['ansi', 'text', 'json', 'xml'],
      });
    });
    change('Output languages', '');
    await vi.waitFor(() => { expect(plugin.settings.outputLanguages).toEqual([]); });
    reset('Output languages');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual(DEFAULT_SETTINGS);
      expect(row('Output languages').querySelector('textarea')?.value).toBe('ansi');
    });
  });

  it('persists command spacing and resets to Middle without changing other settings', async () => {
    const { plugin, tab, saved, row, change, reset } = fixture();
    plugin.settings = parseSettings({ showHeaderCopyButton: true });
    tab.display();
    expect(row('Command spacing').querySelector('select')?.value).toBe('middle');
    for (const commandSpacing of ['small', 'middle', 'large']) {
      change('Command spacing', commandSpacing);
      await vi.waitFor(() => {
        expect(saved[saved.length - 1]).toEqual({
          ...DEFAULT_SETTINGS, showHeaderCopyButton: true, commandSpacing,
        });
      });
    }
    reset('Command spacing');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual({ ...DEFAULT_SETTINGS, showHeaderCopyButton: true });
      expect(row('Command spacing').querySelector('select')?.value).toBe('middle');
    });
  });

  it('saves and resets the global Hippo speech toggle without changing icons', async () => {
    const { plugin, saved, row, change, reset } = fixture();
    expect(row('Tap my hip-po!').querySelector('input')?.checked).toBe(false);
    change('Tap my hip-po!', true);
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual({ ...DEFAULT_SETTINGS, tapMyHippo: true });
    });
    reset('Tap my hip-po!');
    await vi.waitFor(() => {
      expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
      expect(row('Tap my hip-po!').querySelector('input')?.checked).toBe(false);
    });
  });

  it('saves normalized language lists and resets each independently', async () => {
    const { plugin, saved, row, change, reset } = fixture();
    change('Language whitelist', ' JS, javascript\nPy js\tplaintext ');
    change('Language blacklist', ' JS,\nPLAINTEXT,js ');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]?.languageWhitelist).toEqual(['js', 'javascript', 'py', 'plaintext']);
      expect(saved[saved.length - 1]?.languageBlacklist).toEqual(['js', 'plaintext']);
    });
    reset('Language whitelist');
    await vi.waitFor(() => {
      expect(plugin.settings.languageWhitelist).toEqual(DEFAULT_SETTINGS.languageWhitelist);
      expect(plugin.settings.languageBlacklist).toEqual(['js', 'plaintext']);
      expect(row('Language whitelist').querySelector('textarea')?.value)
        .toBe(DEFAULT_SETTINGS.languageWhitelist.join('\n'));
    });
    change('Language whitelist', '');
    await vi.waitFor(() => { expect(plugin.settings.languageWhitelist).toEqual([]); });
    reset('Language blacklist');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual({ ...DEFAULT_SETTINGS, languageWhitelist: [] });
      expect(row('Language blacklist').querySelector('textarea')?.value)
        .toBe(DEFAULT_SETTINGS.languageBlacklist.join('\n'));
    });
  });

  it('keeps header copying opt-in and saves, disables and resets only that setting', async () => {
    const { plugin, saved, row, change, reset } = fixture();
    expect(row('Show header copy button').querySelector('input')?.checked).toBe(false);
    for (const showHeaderCopyButton of [true, false, true]) {
      change('Show header copy button', showHeaderCopyButton);
      await vi.waitFor(() => {
        expect(saved[saved.length - 1]).toEqual({ ...DEFAULT_SETTINGS, showHeaderCopyButton });
      });
    }
    reset('Show header copy button');
    await vi.waitFor(() => {
      expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
      expect(saved[saved.length - 1]).toEqual(DEFAULT_SETTINGS);
      expect(row('Show header copy button').querySelector('input')?.checked).toBe(false);
    });
  });

  it.each(COLOR_MODES)('saves and resets %s output icons, reversal and colors independently of the other mode and headers', async (mode) => {
    const { plugin, tab, saved, row, change, reset } = fixture();
    plugin.settings = parseSettings({
      headerStyles: { light: { titleBold: true } },
      outputToggleStyles: {
        light: { icon: 'monitor', overrideColor: true, color: '#123456' },
        dark: { icon: 'book', overrideColor: true, color: '#abcdef' },
      },
    });
    const before = parseSettings(plugin.settings);
    const other = mode === 'light' ? 'dark' : 'light';
    tab.display();
    change('Color mode', mode);
    await vi.waitFor(() => {
      expect(row('Output toggle icon').querySelector('select')?.value).toBe(before.outputToggleStyles[mode].icon);
    });
    for (const icon of OUTPUT_TOGGLE_ICONS) {
      change('Output toggle icon', icon);
      await vi.waitFor(() => { expect(saved[saved.length - 1]?.outputToggleStyles[mode].icon).toBe(icon); });
    }
    change('Reverse output toggle icons', true);
    await vi.waitFor(() => { expect(saved[saved.length - 1]?.outputToggleStyles[mode].reverseIcons).toBe(true); });
    change('Override output toggle color', false);
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]?.outputToggleStyles[mode].overrideColor).toBe(false);
      expect([...tab.containerEl.querySelectorAll('.setting-item-name')]
        .some((element) => element.textContent === 'Output toggle color')).toBe(false);
    });
    change('Override output toggle color', true);
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]?.outputToggleStyles[mode].overrideColor).toBe(true);
      expect(row('Output toggle color').querySelector('input')).not.toBeNull();
    });
    change('Output toggle color', '#fedcba');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]?.outputToggleStyles[mode]).toEqual({
        icon: 'hippo', reverseIcons: true, overrideColor: true, color: '#fedcba',
      });
    });
    for (const [key, name] of [
      ['color', 'Output toggle color'], ['icon', 'Output toggle icon'], ['overrideColor', 'Override output toggle color'],
      ['reverseIcons', 'Reverse output toggle icons'],
    ] as const) {
      const expected = parseSettings(plugin.settings);
      expected.outputToggleStyles[mode] = {
        ...expected.outputToggleStyles[mode], [key]: DEFAULT_SETTINGS.outputToggleStyles[mode][key],
      };
      reset(name);
      await vi.waitFor(() => { expect(saved[saved.length - 1]).toEqual(expected); });
    }
    expect(plugin.settings.outputToggleStyles[other]).toEqual(before.outputToggleStyles[other]);
    expect(plugin.settings.headerStyles).toEqual(before.headerStyles);
  });

  it('saves and independently resets command block enablement', async () => {
    const { plugin, saved, change, reset } = fixture();
    change('Command blocks', false);
    await vi.waitFor(() => { expect(saved[saved.length - 1]?.commandBlocks).toBe(false); });
    expect(plugin.settings.commandBlocks).toBe(false);
    reset('Command blocks');
    await vi.waitFor(() => { expect(saved[saved.length - 1]?.commandBlocks).toBe(true); });
  });

  it.each(COLOR_MODES)('resets each %s appearance field without changing other settings', async (mode) => {
    const { plugin, tab, saved, row, change, reset } = fixture();
    const customStyle: HeaderStyleSettings = {
      background: 'custom', backgroundColor: '#123456', iconSize: 'large',
      titleBold: true, titleItalic: true, titleFontSize: 20,
      overrideTitleColor: true, titleColor: '#abcdef', languageLabel: 'emphasized',
    };
    plugin.settings = parseSettings({
      showIcon: false,
      headerStyles: {
        light: customStyle,
        dark: { ...customStyle, titleColor: '#fedcba' },
      },
    });
    tab.display();
    change('Color mode', mode);
    await vi.waitFor(() => {
      expect(row('Custom title color').querySelector('input')?.value)
        .toBe(plugin.settings.headerStyles[mode].titleColor);
    });
    const fields: [keyof HeaderStyleSettings, string][] = [
      ['backgroundColor', 'Custom background color'],
      ['titleColor', 'Custom title color'],
      ['iconSize', 'Icon size'],
      ['titleBold', 'Bold title'],
      ['titleItalic', 'Italic title'],
      ['titleFontSize', 'Title font size'],
      ['languageLabel', 'Language label style'],
      ['overrideTitleColor', 'Override title color'],
      ['background', 'Header background'],
    ];
    for (const [key, name] of fields) {
      const before = parseSettings(plugin.settings);
      reset(name);
      const expected = {
        ...before,
        headerStyles: {
          ...before.headerStyles,
          [mode]: { ...before.headerStyles[mode], [key]: DEFAULT_SETTINGS.headerStyles[mode][key] },
        },
      };
      await vi.waitFor(() => {
        expect(plugin.settings).toEqual(expected);
        expect(saved[saved.length - 1]).toEqual(expected);
      });
    }
    expect(row('Icon size').querySelector('select')?.value).toBe('medium');
    expect(row('Title font size').querySelector('input')?.value).toBe('14');
    expect(row('Header background').querySelector('select')?.value).toBe('code');
    expect(row('Override title color').querySelector('input')?.checked).toBe(false);
  });

  it('resets global display toggles individually without resetting appearance', async () => {
    const { plugin, tab, saved, row, reset } = fixture();
    plugin.settings = parseSettings({
      headerDisplay: 'none', showIcon: false, showLanguage: false, lineNumbers: 'none',
      headerStyles: { dark: { titleFontSize: 18 } },
    });
    tab.display();
    for (const [key, name] of [
      ['showIcon', 'Show icon'], ['showLanguage', 'Show language label'],
    ] as const) {
      const expected = { ...parseSettings(plugin.settings), [key]: DEFAULT_SETTINGS[key] };
      reset(name);
      await vi.waitFor(() => {
        expect(plugin.settings).toEqual(expected);
        expect(saved[saved.length - 1]).toEqual(expected);
        expect(row(name).querySelector('input')?.checked).toBe(true);
      });
    }
  });

  it('persists each header display mode and resets to Default without changing other settings', async () => {
    const { plugin, tab, saved, row, change, reset } = fixture();
    plugin.settings = parseSettings({ showLanguage: false, lineNumbers: 'none' });
    tab.display();
    for (const headerDisplay of ['always', 'none', 'default', 'always'] as const) {
      change('Header display', headerDisplay);
      await vi.waitFor(() => {
        expect(saved[saved.length - 1]).toEqual({
          ...DEFAULT_SETTINGS, showLanguage: false, lineNumbers: 'none', headerDisplay,
        });
      });
    }
    reset('Header display');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual({
        ...DEFAULT_SETTINGS, showLanguage: false, lineNumbers: 'none',
      });
      expect(row('Header display').querySelector('select')?.value).toBe('default');
    });
  });

  it('persists each line-number mode and resets to Default without changing header settings', async () => {
    const { plugin, saved, row, change, reset } = fixture();
    for (const lineNumbers of ['always', 'none', 'default', 'always'] as const) {
      change('Line numbers', lineNumbers);
      await vi.waitFor(() => {
        expect(plugin.settings.lineNumbers).toBe(lineNumbers);
        expect(saved[saved.length - 1]).toEqual({ ...DEFAULT_SETTINGS, lineNumbers });
      });
    }
    reset('Line numbers');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual(DEFAULT_SETTINGS);
      expect(row('Line numbers').querySelector('select')?.value).toBe('default');
    });
  });

  it('persists the default fold state and resets it without changing other settings', async () => {
    const { plugin, tab, saved, row, change, reset } = fixture();
    plugin.settings = parseSettings({ showLanguage: false, lineNumbers: 'none' });
    tab.display();
    for (const defaultFoldState of ['folded', 'expanded', 'partial'] as const) {
      change('Default fold state', defaultFoldState);
      await vi.waitFor(() => {
        expect(plugin.settings.defaultFoldState).toBe(defaultFoldState);
        expect(saved[saved.length - 1]).toEqual({
          ...DEFAULT_SETTINGS, showLanguage: false, lineNumbers: 'none', defaultFoldState,
        });
      });
    }
    reset('Default fold state');
    await vi.waitFor(() => {
      expect(plugin.settings.defaultFoldState).toBe('expanded');
      expect(row('Default fold state').querySelector('select')?.value).toBe('expanded');
      expect(saved[saved.length - 1]).toEqual({
        ...DEFAULT_SETTINGS, showLanguage: false, lineNumbers: 'none',
      });
    });
  });

  it('saves positive preview lengths, rejects invalid lengths and resets only the length', async () => {
    const { plugin, tab, saved, row, change, reset, save } = fixture();
    plugin.settings = parseSettings({ defaultFoldState: 'partial', showIcon: false });
    tab.display();
    change('Partial preview lines', '3');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual({
        ...DEFAULT_SETTINGS, defaultFoldState: 'partial', showIcon: false, partialFoldLines: 3,
      });
    });
    const calls = save.mock.calls.length;
    for (const value of ['0', '-1', '1.5']) {
      change('Partial preview lines', value);
      expect(row('Partial preview lines').querySelector('input')?.value).toBe('3');
    }
    expect(save).toHaveBeenCalledTimes(calls);
    expect(Notice.messages[Notice.messages.length - 1]).toContain('positive whole number of lines');
    reset('Partial preview lines');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual({
        ...DEFAULT_SETTINGS, defaultFoldState: 'partial', showIcon: false,
      });
      expect(row('Partial preview lines').querySelector('input')?.value).toBe('5');
    });
  });

  it('saves all appearance controls independently for each mode and rejects invalid sizes', async () => {
    const { plugin, saved, save, row, change } = fixture();
    change('Header background', 'custom');
    await vi.waitFor(() => { expect(row('Custom background color')).toBeDefined(); });
    change('Custom background color', '#123456');
    change('Icon size', 'large');
    change('Bold title', true);
    change('Italic title', true);
    change('Title font size', '20');
    change('Override title color', true);
    await vi.waitFor(() => { expect(row('Custom title color')).toBeDefined(); });
    change('Custom title color', '#abcdef');
    change('Language label style', 'emphasized');
    await vi.waitFor(() => {
      expect(plugin.settings.headerStyles.light).toMatchObject({
        background: 'custom', backgroundColor: '#123456', iconSize: 'large',
        titleBold: true, titleItalic: true, titleFontSize: 20,
        overrideTitleColor: true, titleColor: '#abcdef', languageLabel: 'emphasized',
      });
    });
    change('Color mode', 'dark');
    await vi.waitFor(() => { expect(row('Header background').querySelector('select')?.value).toBe('code'); });
    change('Header background', 'lighter');
    await vi.waitFor(() => { expect(plugin.settings.headerStyles.dark.background).toBe('lighter'); });
    change('Icon size', 'small');
    change('Title font size', '12');
    await vi.waitFor(() => { expect(plugin.settings.headerStyles.dark.titleFontSize).toBe(12); });
    const calls = save.mock.calls.length;
    change('Title font size', '0');
    expect(row('Title font size').querySelector('input')?.value).toBe('12');
    expect(Notice.messages[Notice.messages.length - 1]).toContain('positive whole number');
    expect(save).toHaveBeenCalledTimes(calls);
    expect(saved[saved.length - 1]).toEqual(plugin.settings);
    change('Color mode', 'light');
    await vi.waitFor(() => { expect(row('Custom background color').querySelector('input')?.value).toBe('#123456'); });
    expect(plugin.settings.headerStyles.dark.titleBold).toBe(false);
  });

  it('restores failed edits, reports the error, and allows subsequent saves', async () => {
    const { plugin, save, row, change } = fixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    save.mockRejectedValueOnce(new Error('Write failed'));
    change('Icon size', 'large');
    await vi.waitFor(() => { expect(Notice.messages[Notice.messages.length - 1]).toContain('Failed to save settings'); });
    expect(row('Icon size').querySelector('select')?.value).toBe('medium');
    expect(plugin.settings.headerStyles.light.iconSize).toBe('medium');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to save settings'), expect.any(Error));
    change('Bold title', true);
    await vi.waitFor(() => { expect(plugin.settings.headerStyles.light.titleBold).toBe(true); });
  });

  it('serializes rapid edits so a pending save cannot overwrite a later setting', async () => {
    const { plugin, save, change } = fixture();
    let finish: () => void = () => { throw new Error('Pending save not started.'); };
    save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    change('Icon size', 'large');
    change('Bold title', true);
    await vi.waitFor(() => { expect(save).toHaveBeenCalledOnce(); });
    expect(plugin.settings.headerStyles.light.titleBold).toBe(false);
    finish();
    await vi.waitFor(() => { expect(save).toHaveBeenCalledTimes(2); });
    expect(plugin.settings.headerStyles.light).toMatchObject({ iconSize: 'large', titleBold: true });
  });
});
