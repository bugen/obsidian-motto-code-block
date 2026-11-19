// @vitest-environment happy-dom
import { App, Setting, SettingGroup, type SettingDefinitionItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MottoCodeBlockPlugin from '../src/main';
import {
  COLOR_MODES, DEFAULT_SETTINGS, OUTPUT_TOGGLE_ICONS, parseSettings,
  type HeaderStyleSettings, type MottoSettings,
} from '../src/settings';
import { MottoSettingsTab } from '../src/settings-tab';
import { Notice } from './obsidian';

function fixture(declarative = false) {
  const app = new App();
  const plugin = new MottoCodeBlockPlugin(app, {
    id: 'motto-code-block', name: 'Motto Code Block', version: '0.1.0',
    minAppVersion: '1.5.0', author: '', description: '',
  });
  const saved: MottoSettings[] = [];
  const save = vi.spyOn(plugin, 'saveSettings').mockImplementation(async () => {
    saved.push(parseSettings(plugin.settings));
  });
  const tab = new MottoSettingsTab(app, plugin);
  document.body.append(tab.containerEl);
  const cleanups: (() => void)[] = [];
  function renderDefinitions(): void {
    for (const cleanup of cleanups.splice(0)) cleanup();
    tab.containerEl.replaceChildren();
    function render(item: SettingDefinitionItem, parent: HTMLElement): void {
      if ('type' in item) {
        if (item.type !== 'group') throw new Error('Unsupported settings definition.');
        const group = parent.createEl('section');
        group.className = item.cls ?? '';
        for (const child of item.items ?? []) render(child, group);
      } else if (item.render) {
        const cleanup = item.render(new Setting(parent), new SettingGroup(parent));
        if (cleanup) cleanups.push(cleanup);
      } else throw new Error('Missing custom settings renderer.');
    }
    for (const item of tab.getSettingDefinitions()) render(item, tab.containerEl);
  }
  if (declarative) {
    vi.spyOn(tab, 'update').mockImplementation(renderDefinitions);
    tab.update();
  } else tab.display();
  function row(name: string) {
    const element = [...tab.containerEl.querySelectorAll<HTMLElement>('.setting-item')]
      .find((element) => element.querySelector('.setting-item-name')?.textContent === name &&
        element.querySelector('input, select, textarea, button'));
    if (!element) throw new Error(`Missing setting: ${name}`);
    return element;
  }
  function change(name: string, value: string | boolean) {
    if (name === 'Editing theme') {
      const button = [...row(name).querySelectorAll<HTMLButtonElement>('[data-motto-theme]')]
        .find((element) => element.dataset.mottoTheme === value);
      if (!button) throw new Error(`Missing theme: ${value}`);
      button.click();
      return;
    }
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
  function modified(name: string) {
    return row(name).querySelector('[aria-label="Restore default"]')?.classList.contains('motto-reset-modified');
  }
  return { plugin, tab, save, saved, row, change, reset, modified };
}

afterEach(() => {
  vi.restoreAllMocks();
  Notice.messages.length = 0;
  document.body.replaceChildren();
  document.body.className = '';
});

describe('settings tab', () => {
  it('provides searchable definitions for every control without rendering during indexing', () => {
    const { tab } = fixture();
    const create = vi.spyOn(document, 'createElement');
    const before = tab.containerEl.innerHTML;
    const definitions = tab.getSettingDefinitions();
    expect(create).not.toHaveBeenCalled();
    expect(tab.containerEl.innerHTML).toBe(before);
    const terms: string[] = [];
    function collect(items: SettingDefinitionItem[]): void {
      for (const item of items) {
        if ('type' in item) {
          if (item.type !== 'group') throw new Error('Unsupported settings definition.');
          collect(item.items ?? []);
        } else terms.push(item.name, ...item.aliases ?? []);
      }
    }
    collect(definitions);
    for (const row of tab.containerEl.querySelectorAll<HTMLElement>('[data-motto-setting]')) {
      expect(terms).toContain(row.dataset.mottoSetting);
    }
    for (const name of ['Custom background color', 'Custom title color', 'Output toggle color']) {
      expect(terms).toContain(name);
    }
  });

  it('renders, persists and refreshes the same controls through the declarative API', async () => {
    document.body.className = 'theme-dark';
    const { plugin, tab, change, row, reset } = fixture(true);
    expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Dark');
    change('Header background', 'custom');
    await vi.waitFor(() => { expect(row('Custom background color')).toBeDefined(); });
    change('Custom background color', '#123456');
    change('Line numbers', 'always');
    await vi.waitFor(() => {
      expect(plugin.settings.headerStyles.dark.backgroundColor).toBe('#123456');
      expect(plugin.settings.lineNumbers).toBe('always');
    });
    change('Editing theme', 'light');
    await vi.waitFor(() => { expect(row('Header background').querySelector('select')?.value).toBe('code'); });
    change('Command blocks', false);
    await vi.waitFor(() => { expect(row('Output languages').querySelector('textarea')?.disabled).toBe(true); });
    reset('Command blocks');
    await vi.waitFor(() => { expect(row('Output languages').querySelector('textarea')?.disabled).toBe(false); });
    tab.hide();
    tab.update();
    expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Dark');
  });

  it('recovers declarative controls after a save fails without changing the selected editing theme', async () => {
    const { plugin, tab, save, change, row } = fixture(true);
    change('Editing theme', 'dark');
    await vi.waitFor(() => { expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Dark'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    save.mockRejectedValueOnce(new Error('Write failed'));
    change('Bold title', true);
    await vi.waitFor(() => { expect(log).toHaveBeenCalled(); });
    expect(plugin.settings.headerStyles.dark.titleBold).toBe(false);
    expect(tab.update).toHaveBeenCalledTimes(2);
    expect(row('Bold title').querySelector('input')?.checked).toBe(false);
    expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Dark');
    change('Bold title', true);
    await vi.waitFor(() => { expect(plugin.settings.headerStyles.dark.titleBold).toBe(true); });
  });

  it('groups behavior and appearance by target beneath the theme selector', () => {
    const { tab, row } = fixture();
    expect(tab.containerEl.querySelector('.setting-item-name')?.textContent).toBe('Editing theme');
    const sections = [...tab.containerEl.querySelectorAll<HTMLElement>('.motto-settings-level-2')];
    expect(sections.map((section) => section.querySelector('[role="heading"]')?.textContent))
      .toEqual(['General', 'Code blocks', 'Command blocks']);
    expect(sections[0]?.contains(row('Language include list'))).toBe(true);
    for (const name of ['Header display', 'Icon size', 'Header background', 'Bold title', 'Line numbers']) {
      expect(sections[1]?.contains(row(name))).toBe(true);
    }
    for (const name of ['Command blocks', 'Output languages', 'Output toggle icon', 'Tap my hip-po!']) {
      expect(sections[2]?.contains(row(name))).toBe(true);
    }
    expect(row('Show icon').nextElementSibling?.contains(row('Icon size'))).toBe(true);
    expect(row('Show language label').nextElementSibling?.contains(row('Language label style'))).toBe(true);
  });

  it('renders the inline theme icon even when setDesc only supports text', () => {
    vi.spyOn(Setting.prototype, 'setDesc').mockImplementation(function (this: Setting, description) {
      this.descEl.textContent = String(description);
      return this;
    });
    const { row } = fixture();
    const description = row('Editing theme').querySelector('.setting-item-description')!;
    const icon = description.querySelector('[role="img"]');
    expect(icon?.getAttribute('aria-label')).toBeTruthy();
    expect(icon?.querySelector('svg')?.isEqualNode(row('Icon size').querySelector('svg'))).toBe(true);
    expect(description.textContent).not.toContain('the half-filled circle');
    expect(description.textContent).not.toContain('[object DocumentFragment]');
    expect(description.textContent).toContain('All other settings are shared.');
  });

  it('highlights changed common settings and clears the highlight when restored manually or reset', async () => {
    const { tab, change, reset, modified } = fixture();
    expect(tab.containerEl.querySelector('.motto-reset-modified')).toBeNull();
    for (const [name, value, defaultValue] of [
      ['Show header copy button', true, false],
      ['Command spacing', 'large', 'middle'],
      ['Partial preview lines', '3', '5'],
      ['Output languages', 'text', 'ansi'],
    ] as const) {
      change(name, value);
      await vi.waitFor(() => { expect(modified(name)).toBe(true); });
      expect(modified('Line numbers')).toBe(false);
      change(name, defaultValue);
      await vi.waitFor(() => { expect(modified(name)).toBe(false); });
      change(name, value);
      await vi.waitFor(() => { expect(modified(name)).toBe(true); });
      reset(name);
      await vi.waitFor(() => { expect(modified(name)).toBe(false); });
    }
  });

  it('compares language lists by normalized membership rather than formatting or order', async () => {
    const { change, save, reset, modified } = fixture();
    change('Language include list', [...DEFAULT_SETTINGS.languageIncludeList].reverse().join(', ').toUpperCase());
    change('Language exclude list', 'MERMAID,\nmermaid');
    await vi.waitFor(() => { expect(save).toHaveBeenCalledTimes(2); });
    expect(modified('Language include list')).toBe(false);
    expect(modified('Language exclude list')).toBe(false);
    change('Language exclude list', 'json');
    await vi.waitFor(() => { expect(modified('Language exclude list')).toBe(true); });
    reset('Language exclude list');
    await vi.waitFor(() => { expect(modified('Language exclude list')).toBe(false); });
  });

  it('keeps theme-specific reset highlights separate while retaining common highlights', async () => {
    const { change, reset, modified, row } = fixture();
    change('Show header copy button', true);
    change('Icon size', 'large');
    await vi.waitFor(() => { expect(modified('Icon size')).toBe(true); });
    change('Editing theme', 'dark');
    await vi.waitFor(() => {
      expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Dark');
    });
    expect(modified('Icon size')).toBe(false);
    expect(modified('Show header copy button')).toBe(true);
    change('Icon size', 'small');
    await vi.waitFor(() => { expect(modified('Icon size')).toBe(true); });
    reset('Icon size');
    await vi.waitFor(() => { expect(modified('Icon size')).toBe(false); });
    change('Editing theme', 'light');
    await vi.waitFor(() => {
      expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Light');
    });
    expect(modified('Icon size')).toBe(true);
    reset('Icon size');
    await vi.waitFor(() => { expect(modified('Icon size')).toBe(false); });
    expect(modified('Show header copy button')).toBe(true);
  });

  it.each(COLOR_MODES)('selects the active %s theme on every opening but preserves manual choices during edits and resets', async (mode) => {
    document.body.classList.toggle('theme-dark', mode === 'dark');
    const { plugin, tab, row, change, reset, save } = fixture();
    const selected = () => row('Editing theme').querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.dataset.mottoTheme;
    const other = mode === 'light' ? 'dark' : 'light';
    expect(selected()).toBe(mode);
    change('Editing theme', other);
    await vi.waitFor(() => { expect(selected()).toBe(other); });
    expect(save).not.toHaveBeenCalled();
    change('Header background', 'custom');
    await vi.waitFor(() => {
      expect(row('Custom background color')).toBeDefined();
      expect(plugin.settings.headerStyles[other].background).toBe('custom');
    });
    expect(plugin.settings.headerStyles[mode].background).toBe('code');
    expect(selected()).toBe(other);
    expect(document.body.classList.contains('theme-dark')).toBe(mode === 'dark');
    reset('Header background');
    await vi.waitFor(() => { expect(row('Header background').querySelector('select')?.value).toBe('code'); });
    expect(selected()).toBe(other);
    tab.display();
    expect(selected()).toBe(mode);
    document.body.classList.toggle('theme-dark', other === 'dark');
    tab.display();
    expect(selected()).toBe(other);
  });

  it('marks only per-theme fields, including conditionally visible colors', async () => {
    const { plugin, tab, row, change } = fixture();
    plugin.settings = parseSettings({
      headerStyles: { light: { background: 'custom', overrideTitleColor: true } },
      outputToggleStyles: { light: { overrideColor: true } },
    });
    tab.display();
    const marked = () => [...tab.containerEl.querySelectorAll('.setting-item-name .motto-theme-setting-icon')]
      .map((marker) => marker.closest<HTMLElement>('[data-motto-setting]')?.dataset.mottoSetting);
    expect(marked()).toEqual([
      'Icon size', 'Language label style', 'Header background', 'Custom background color',
      'Bold title', 'Italic title', 'Title font size', 'Override title color', 'Custom title color',
      'Output toggle icon', 'Reverse output toggle icons', 'Override output toggle color', 'Output toggle color',
    ]);
    expect(row('Icon size').querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Editing Light');
    change('Editing theme', 'dark');
    await vi.waitFor(() => {
      expect(row('Icon size').querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Editing Dark');
    });
    expect(marked()).not.toContain('Custom background color');
    expect(marked()).not.toContain('Custom title color');
    expect(marked()).not.toContain('Output toggle color');
  });

  it('updates only the affected theme controls while retaining common inputs, focus and scroll', async () => {
    const { tab, row, change, reset } = fixture();
    const common = row('Language include list').querySelector('textarea')!;
    const selector = row('Editing theme');
    const dark = selector.querySelector<HTMLButtonElement>('[data-motto-theme="dark"]')!;
    common.value = 'uncommitted input';
    dark.focus();
    tab.containerEl.scrollTop = 90;
    change('Editing theme', 'dark');
    await vi.waitFor(() => { expect(dark.getAttribute('aria-pressed')).toBe('true'); });
    expect(row('Language include list').querySelector('textarea')).toBe(common);
    expect(common.value).toBe('uncommitted input');
    expect(row('Editing theme')).toBe(selector);
    expect(document.activeElement).toBe(dark);
    expect(tab.containerEl.scrollTop).toBe(90);
    const title = row('Title font size');
    row('Header background').querySelector('select')!.focus();
    change('Header background', 'custom');
    await vi.waitFor(() => { expect(row('Custom background color')).toBeDefined(); });
    expect(document.activeElement).toBe(row('Header background').querySelector('select'));
    expect(row('Title font size')).toBe(title);
    expect(row('Language include list').querySelector('textarea')).toBe(common);
    const background = row('Header background');
    change('Override output toggle color', true);
    await vi.waitFor(() => { expect(row('Output toggle color')).toBeDefined(); });
    expect(row('Header background')).toBe(background);
    reset('Command spacing');
    await vi.waitFor(() => { expect(row('Command spacing').querySelector('select')?.value).toBe('middle'); });
    expect(row('Editing theme')).toBe(selector);
    expect(common.value).toBe('uncommitted input');
    expect(tab.containerEl.scrollTop).toBe(90);
  });

  it('disables dependent controls without discarding either theme or common values', async () => {
    const { plugin, tab, row, change, reset } = fixture();
    plugin.settings = parseSettings({
      headerStyles: { light: { iconSize: 'large', languageLabel: 'emphasized' } },
      outputToggleStyles: { light: { icon: 'hippo', overrideColor: true, color: '#123456' } },
    });
    tab.display();
    const before = parseSettings(plugin.settings);
    change('Show icon', false);
    await vi.waitFor(() => { expect(row('Icon size').querySelector('select')?.disabled).toBe(true); });
    expect(row('Icon size').querySelector('button')?.disabled).toBe(true);
    expect(row('Language label style').querySelector('select')?.disabled).toBe(false);
    change('Show language label', false);
    await vi.waitFor(() => { expect(row('Language label style').querySelector('select')?.disabled).toBe(true); });
    change('Header display', 'none');
    await vi.waitFor(() => { expect(row('Header background').querySelector('select')?.disabled).toBe(true); });
    expect(row('Show icon').querySelector('input')?.disabled).toBe(true);
    expect(row('Title font size').querySelector('input')?.disabled).toBe(true);
    expect(row('Line numbers').querySelector('select')?.disabled).toBe(false);
    reset('Header display');
    await vi.waitFor(() => { expect(row('Show icon').querySelector('input')?.disabled).toBe(false); });
    change('Show icon', true);
    change('Show language label', true);
    await vi.waitFor(() => { expect(row('Language label style').querySelector('select')?.disabled).toBe(false); });
    expect(row('Icon size').querySelector('select')?.value).toBe('large');
    change('Command blocks', false);
    await vi.waitFor(() => { expect(row('Output toggle icon').querySelector('select')?.disabled).toBe(true); });
    expect(row('Output languages').querySelector('textarea')?.disabled).toBe(true);
    expect(row('Command spacing').querySelector('select')?.disabled).toBe(true);
    expect(row('Tap my hip-po!').querySelector('input')?.disabled).toBe(true);
    expect(row('Header background').querySelector('select')?.disabled).toBe(false);
    reset('Command blocks');
    await vi.waitFor(() => { expect(row('Output toggle icon').querySelector('select')?.disabled).toBe(false); });
    expect(plugin.settings).toEqual(before);
  });

  it('waits for pending saves before switching themes so edits stay with their original theme', async () => {
    const { plugin, save, row, change } = fixture();
    let finish: () => void = () => { throw new Error('Pending save not started.'); };
    save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    change('Icon size', 'large');
    await vi.waitFor(() => { expect(save).toHaveBeenCalledOnce(); });
    change('Editing theme', 'dark');
    expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Light');
    finish();
    await vi.waitFor(() => {
      expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Dark');
    });
    expect(plugin.settings.headerStyles.light.iconSize).toBe('large');
    expect(plugin.settings.headerStyles.dark.iconSize).toBe('medium');
    expect(row('Icon size').querySelector('select')?.value).toBe('medium');
  });

  it.each(['reopening', 'save failure'])('ignores a queued theme switch from a view replaced by %s', async (reason) => {
    const { tab, save, row, change } = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let finish: () => void = () => { throw new Error('Pending save not started.'); };
    save.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finish = () => { if (reason === 'save failure') reject(new Error('Write failed')); else resolve(); };
    }));
    change('Header background', 'custom');
    await vi.waitFor(() => { expect(save).toHaveBeenCalledOnce(); });
    change('Editing theme', 'dark');
    if (reason === 'reopening') tab.display();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Light');
    expect(row('Icon size').querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Editing Light');
    change('Editing theme', 'dark');
    await vi.waitFor(() => {
      expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Dark');
    });
  });

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
    change('Language include list', ' JS, javascript\nPy js\tplaintext ');
    change('Language exclude list', ' JS,\nPLAINTEXT,js ');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]?.languageIncludeList).toEqual(['js', 'javascript', 'py', 'plaintext']);
      expect(saved[saved.length - 1]?.languageExcludeList).toEqual(['js', 'plaintext']);
    });
    reset('Language include list');
    await vi.waitFor(() => {
      expect(plugin.settings.languageIncludeList).toEqual(DEFAULT_SETTINGS.languageIncludeList);
      expect(plugin.settings.languageExcludeList).toEqual(['js', 'plaintext']);
      expect(row('Language include list').querySelector('textarea')?.value)
        .toBe(DEFAULT_SETTINGS.languageIncludeList.join('\n'));
    });
    change('Language include list', '');
    await vi.waitFor(() => { expect(plugin.settings.languageIncludeList).toEqual([]); });
    reset('Language exclude list');
    await vi.waitFor(() => {
      expect(saved[saved.length - 1]).toEqual({ ...DEFAULT_SETTINGS, languageIncludeList: [] });
      expect(row('Language exclude list').querySelector('textarea')?.value)
        .toBe(DEFAULT_SETTINGS.languageExcludeList.join('\n'));
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
    const { plugin, tab, saved, row, change, reset, modified } = fixture();
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
    change('Editing theme', mode);
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
      expect(modified(name)).toBe(true);
      reset(name);
      await vi.waitFor(() => {
        expect(saved[saved.length - 1]).toEqual(expected);
        expect(modified(name)).toBe(false);
      });
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
    const { plugin, tab, saved, row, change, reset, modified } = fixture();
    const customStyle: HeaderStyleSettings = {
      background: 'custom', backgroundColor: '#123456', iconSize: 'large',
      titleBold: true, titleItalic: true, titleFontSize: 20,
      overrideTitleColor: true, titleColor: '#abcdef', languageLabel: 'emphasized',
    };
    plugin.settings = parseSettings({
      showHeaderCopyButton: true,
      headerStyles: {
        light: customStyle,
        dark: { ...customStyle, titleColor: '#fedcba' },
      },
    });
    tab.display();
    change('Editing theme', mode);
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
      expect(modified(name)).toBe(true);
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
        expect(modified(name)).toBe(false);
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
      headerDisplay: 'always', showIcon: false, showLanguage: false, lineNumbers: 'none',
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
    change('Editing theme', 'dark');
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
    change('Editing theme', 'light');
    await vi.waitFor(() => { expect(row('Custom background color').querySelector('input')?.value).toBe('#123456'); });
    expect(plugin.settings.headerStyles.dark.titleBold).toBe(false);
  });

  it('restores failed edits, reports the error, and allows subsequent saves', async () => {
    const { plugin, save, row, change, reset, modified } = fixture();
    change('Editing theme', 'dark');
    await vi.waitFor(() => {
      expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Dark');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    save.mockRejectedValueOnce(new Error('Write failed'));
    change('Icon size', 'large');
    await vi.waitFor(() => { expect(Notice.messages[Notice.messages.length - 1]).toContain('Failed to save settings'); });
    expect(row('Icon size').querySelector('select')?.value).toBe('medium');
    expect(plugin.settings.headerStyles.dark.iconSize).toBe('medium');
    expect(modified('Icon size')).toBe(false);
    expect(row('Editing theme').querySelector('[aria-pressed="true"]')?.textContent).toBe('Dark');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to save settings'), expect.any(Error));
    change('Bold title', true);
    await vi.waitFor(() => {
      expect(plugin.settings.headerStyles.dark.titleBold).toBe(true);
      expect(modified('Bold title')).toBe(true);
    });
    const notices = Notice.messages.length;
    save.mockRejectedValueOnce(new Error('Reset failed'));
    reset('Bold title');
    await vi.waitFor(() => { expect(Notice.messages).toHaveLength(notices + 1); });
    expect(plugin.settings.headerStyles.dark.titleBold).toBe(true);
    expect(modified('Bold title')).toBe(true);
    reset('Bold title');
    await vi.waitFor(() => { expect(modified('Bold title')).toBe(false); });
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
