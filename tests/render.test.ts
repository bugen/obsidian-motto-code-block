// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import * as obsidian from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCodeBlocks, parseInfo } from '../src/codeblock';
import { ansiPreview, commandOutput, commandOutputPreview, commandTools, setOutputToggle } from '../src/command-render';
import { languages } from '../src/languages';
import { applyHeaderStyles, createExpandFooter, createHeader, languagePresentation, setHeaderFoldState } from '../src/render';
import { DEFAULT_SETTINGS, parseSettings } from '../src/settings';
import { Notice } from './obsidian';

afterEach(() => {
  vi.restoreAllMocks();
  Notice.messages.length = 0;
});

describe('header display', () => {
  it.each(['text', 'json', 'xml'])('renders and copies %s output literally without ANSI stripping or HTML interpretation', async (language) => {
    const text = '\x1b[31m<img src=x onerror=alert(1)>\x1b[0m\nlast line';
    const block = parseCodeBlocks(`\`\`\`${language}\n${text}\n\`\`\``).blocks[0]!;
    const preview = commandOutputPreview(document, block, undefined, vi.fn());
    const code = preview.element.querySelector('code')!;
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    expect(code.classList.contains(`language-${language}`)).toBe(true);
    await vi.waitFor(() => {
      expect(code.textContent).toBe(text);
      expect(code.querySelectorAll('.token').length > 0).toBe(language !== 'text');
    });
    expect(code.querySelector('img, script, a')).toBeNull();
    preview.element.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(text);
    preview.destroy();
  });

  it('reports highlighting failures while retaining the original output text', async () => {
    const error = new Error('Prism unavailable');
    vi.spyOn(obsidian, 'loadPrism').mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const output = commandOutput(document, '{"ok":true}', undefined, 'json');
    await vi.waitFor(() => { expect(log).toHaveBeenCalledWith('[Motto Code Block] Failed to highlight output.', error); });
    expect(Notice.messages).toContain('Motto Code Block: Failed to highlight output.');
    expect(output.querySelector('code')?.textContent).toBe('{"ok":true}');
  });

  it.each(['markdown-rendered', 'markdown-source-view'])('aligns command and output copy controls on the same vertical axis in %s', (context) => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    const container = document.createElement('div');
    container.className = context;
    const command = document.createElement('div');
    command.className = context === 'markdown-rendered' ? 'motto-command-row' : 'motto-command-marker';
    const tools = commandTools(document, 'pwd', true, DEFAULT_SETTINGS.outputToggleStyles, vi.fn());
    command.append(tools);
    const output = commandOutput(document, '/srv', vi.fn());
    container.append(command, output);
    document.head.append(stylesheet);
    document.body.append(container);
    try {
      const commandInset = context === 'markdown-rendered'
        ? getComputedStyle(command).paddingRight : getComputedStyle(tools).insetInlineEnd;
      expect(getComputedStyle(output.querySelector('.motto-output-tools')!).right).toBe(commandInset);
    } finally {
      container.remove();
      stylesheet.remove();
    }
  });

  it.each(['numbered standalone', 'partial paired output'])('keeps ANSI edit and copy controls above positioned %s previews', (kind) => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    const block = parseCodeBlocks('```ansi\nfirst\nsecond\nthird\n```').blocks[0]!;
    const preview = kind === 'numbered standalone'
      ? ansiPreview(document, block, DEFAULT_SETTINGS, undefined, vi.fn())
      : commandOutputPreview(document, block, 1, vi.fn(), vi.fn());
    const container = document.createElement('div');
    container.className = 'markdown-source-view mod-cm6';
    container.append(preview.element);
    document.head.append(stylesheet);
    document.body.append(container);
    try {
      expect(getComputedStyle(preview.element.querySelector('pre')!).position).toBe('relative');
      const tools = getComputedStyle(preview.element.querySelector('.motto-output-tools')!);
      expect(tools.position).toBe('absolute');
      expect(Number(tools.zIndex)).toBeGreaterThan(0);
    } finally {
      preview.destroy();
      container.remove();
      stylesheet.remove();
    }
  });

  it('keeps Obsidian tooltip labels without duplicate native tooltips on operation buttons', () => {
    const header = createHeader(document, { language: 'sh', title: 'Run', text: 'pwd', hasParameters: true }, {
      ...DEFAULT_SETTINGS, showHeaderCopyButton: true,
    }, {
      state: 'expanded', toggle: vi.fn(),
    })!;
    const controls = document.createElement('div');
    controls.append(
      commandTools(document, 'pwd', false, DEFAULT_SETTINGS.outputToggleStyles, vi.fn()),
      commandOutput(document, '/srv', vi.fn()),
      header,
    );
    expect([...controls.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual([
      'Show output', 'Copy command', 'Edit source', 'Copy output', 'Copy code block', 'Run: toggle code block',
    ]);
    for (const state of ['expanded', 'folded', 'partial'] as const) {
      setHeaderFoldState(header, state);
      for (const button of controls.querySelectorAll('button')) {
        expect(button.hasAttribute('title')).toBe(false);
        expect(button.getAttribute('aria-label')).toBeTruthy();
      }
    }
  });

  it.each([
    ['eye', 'eye', 'eye-off'],
    ['monitor', 'monitor', 'monitor-off'],
    ['expand', 'chevrons-up-down', 'chevrons-down-up'],
    ['book', 'book-open', 'book'],
    ['chevron', 'chevron-down', 'chevron-up'],
  ])('uses the %s output icons for the next action with accessible labels and unchanged click handling', (icon, show, hide) => {
    const toggle = vi.fn();
    const parentClick = vi.fn();
    const styles = parseSettings({ outputToggleStyles: { light: { icon }, dark: { icon } } }).outputToggleStyles;
    const tools = commandTools(document, 'pwd', false, styles, toggle);
    tools.addEventListener('click', parentClick);
    const button = tools.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    expect(button.textContent).toBe('');
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Show output');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect([...button.querySelectorAll('svg')].map((svg) => svg.getAttribute('data-icon'))).toEqual([show, show]);
    button.click();
    expect(toggle).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
    setOutputToggle(button, true, styles);
    expect(button.textContent).toBe('');
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Hide output');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect([...button.querySelectorAll('svg')].map((svg) => svg.getAttribute('data-icon'))).toEqual([hide, hide]);
    const reversed = parseSettings({
      outputToggleStyles: { light: { icon, reverseIcons: true }, dark: { icon, reverseIcons: true } },
    }).outputToggleStyles;
    setOutputToggle(button, false, reversed);
    expect([...button.querySelectorAll('svg')].map((svg) => svg.getAttribute('data-icon'))).toEqual([hide, hide]);
    expect(button.getAttribute('aria-label')).toBe('Show output');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    setOutputToggle(button, true, reversed);
    expect([...button.querySelectorAll('svg')].map((svg) => svg.getAttribute('data-icon'))).toEqual([show, show]);
    expect(button.getAttribute('aria-label')).toBe('Hide output');
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it.each([false, true])('faces Hippo left to show output and right to hide it, respecting per-theme reversal (%s)', (reverseIcons) => {
    const styles = parseSettings({
      outputToggleStyles: {
        light: { icon: 'hippo', reverseIcons },
        dark: { icon: 'hippo', reverseIcons: !reverseIcons },
      },
    }).outputToggleStyles;
    const tools = commandTools(document, 'pwd', false, styles, () => {});
    const button = tools.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    const stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    document.head.append(stylesheet);
    document.body.append(tools);
    try {
      button.focus();
      for (const open of [false, true]) {
        setOutputToggle(button, open, styles);
        for (const mode of ['light', 'dark'] as const) {
          const icon = button.querySelector<HTMLElement>(`.motto-output-icon-${mode} .motto-output-hippo`)!;
          const mirrored = open === styles[mode].reverseIcons;
          expect(icon.style.maskImage).toMatch(/^url\(/);
          expect(getComputedStyle(icon).transform).toBe(mirrored ? 'scaleX(-1)' : '');
        }
        expect(document.activeElement).toBe(button);
        expect(button.getAttribute('aria-label')).toBe(open ? 'Hide output' : 'Show output');
        expect(button.hasAttribute('title')).toBe(false);
        expect(button.getAttribute('aria-expanded')).toBe(String(open));
      }
    } finally {
      tools.remove();
      stylesheet.remove();
    }
  });

  it.each([
    ['light', 'hippo', 'eye', 32],
    ['dark', 'hippo', 'eye', 24],
    ['light', 'eye', 'hippo', 24],
    ['dark', 'eye', 'hippo', 32],
  ])('widens only the active Hippo controls in %s mode (light: %s, dark: %s)', (mode, light, dark, width) => {
    const styles = parseSettings({
      outputToggleStyles: { light: { icon: light }, dark: { icon: dark } },
    }).outputToggleStyles;
    const tools = commandTools(document, 'pwd', false, styles, () => {});
    const line = document.createElement('div');
    line.className = 'cm-line motto-command-line';
    line.style.setProperty('--motto-command-tools-width', '68px');
    line.append(tools);
    const stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    const previousClass = document.body.className;
    document.body.className = `theme-${mode}`;
    document.head.append(stylesheet);
    document.body.append(line);
    try {
      expect(getComputedStyle(tools.querySelector('.motto-output-toggle')!).width).toBe(`${width}px`);
      const hippo = getComputedStyle(tools.querySelector('.motto-output-hippo')!);
      expect([hippo.width, hippo.height]).toEqual(['27px', '18px']);
      expect(getComputedStyle(line).getPropertyValue('--motto-output-toggle-extra-width')).toBe(width === 32 ? '8px' : '');
      expect(getComputedStyle(tools.querySelector('.motto-command-copy')!).minWidth).toBe('24px');
    } finally {
      line.remove();
      stylesheet.remove();
      document.body.className = previousClass;
    }
  });

  it('hides native copies in rendered commands and output without affecting ordinary blocks', () => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = `${readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8')}
      .is-mobile .markdown-rendered pre:not(:hover) > button.copy-code-button { display: block; }`;
    const container = document.createElement('div');
    container.className = 'is-mobile';
    const reading = document.createElement('div');
    reading.className = 'markdown-rendered';
    container.append(reading);
    const command = document.createElement('div');
    command.className = 'motto-command-view';
    const output = commandOutput(document, '/srv');
    reading.append(command, output);
    const labels = [command, output, reading].map((parent) => {
      const pre = document.createElement('pre');
      const button = document.createElement('button');
      button.className = 'copy-code-button';
      button.textContent = 'Shell';
      pre.append(button);
      parent.append(pre);
      return button;
    });
    document.head.append(stylesheet);
    document.body.append(container);
    try {
      expect(labels.map((label) => getComputedStyle(label).display)).toEqual(['none', 'none', 'block']);
      expect(getComputedStyle(output.querySelector('.motto-command-copy')!).display).toBe('inline-flex');
    } finally {
      container.remove();
      stylesheet.remove();
    }
  });

  it.each([
    ['markdown-rendered', 'light'],
    ['markdown-rendered', 'dark'],
    ['markdown-source-view', 'light'],
    ['markdown-source-view', 'dark'],
  ])('keeps Show all gradients based on code colors and frameless despite native styles in %s (%s)', (context, mode) => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = `${readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8')}
      button:not(.clickable-icon) {
        background-color: rgb(240, 240, 240);
        border: 1px solid rgb(100, 100, 100);
        box-shadow: 0 1px 2px rgb(0, 0, 0);
      }`;
    const container = document.createElement('div');
    container.className = context;
    container.style.setProperty('--code-background', 'rgb(220, 220, 220)');
    const output = document.createElement('div');
    output.className = 'motto-ansi-view motto-command-output motto-command-output-partial';
    const footer = createExpandFooter(document, 39, () => {});
    output.append(footer);
    const codeFooter = createExpandFooter(document, 39, () => {});
    container.append(codeFooter, output);
    const previousClass = document.body.className;
    document.body.className = `theme-${mode}`;
    document.head.append(stylesheet);
    document.body.append(container);
    try {
      for (const button of container.querySelectorAll('button')) {
        const style = getComputedStyle(button);
        // Happy DOM cannot resolve gradients containing color-mix().
        const colors = getComputedStyle(button.parentElement!);
        const surface = colors.getPropertyValue('--motto-expand-surface');
        const background = colors.getPropertyValue('--motto-expand-background');
        expect(surface).toContain('rgb(220, 220, 220)');
        expect(background).toContain(surface);
        expect(background).toContain(mode === 'light' ? 'white' : 'black');
        expect(style.boxShadow).toBe('none');
        expect([style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle])
          .toEqual(['none', 'none', 'none', 'none']);
      }
      expect(getComputedStyle(codeFooter).backgroundColor).toBe('rgb(220, 220, 220)');
      expect(codeFooter.querySelector('button')?.className).toBe('motto-expand-button');
      expect(getComputedStyle(footer).marginBlockStart).toBe('12px');
    } finally {
      container.remove();
      stylesheet.remove();
      document.body.className = previousClass;
    }
  });

  it('keeps command and output controls frameless despite native button styles', () => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = `${readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8')}
      button:not(.clickable-icon) {
        background-color: rgb(240, 240, 240);
        box-shadow: 0 1px 2px rgb(0, 0, 0);
      }`;
    const controls = document.createElement('div');
    controls.style.setProperty('--text-accent', 'rgb(20, 120, 190)');
    controls.style.setProperty('--text-normal', 'rgb(30, 40, 50)');
    controls.style.setProperty('--text-muted', 'rgb(100, 110, 120)');
    controls.append(commandTools(document, 'pwd', false, DEFAULT_SETTINGS.outputToggleStyles, () => {}),
      commandOutput(document, '/srv', () => {}));
    document.head.append(stylesheet);
    document.body.append(controls);
    try {
      for (const button of controls.querySelectorAll('button')) {
        const style = getComputedStyle(button);
        expect(style.backgroundColor).toBe('transparent');
        expect(style.boxShadow).toBe('none');
        expect(style.borderTopStyle).toBe('none');
      }
      const toggle = controls.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
      const copy = controls.querySelector('.motto-command-copy')!;
      expect(getComputedStyle(toggle).color).toBe(getComputedStyle(copy).color);
      setOutputToggle(toggle, true, DEFAULT_SETTINGS.outputToggleStyles);
      expect(getComputedStyle(toggle).color).toBe(getComputedStyle(copy).color);
    } finally {
      controls.remove();
      stylesheet.remove();
    }
  });

  it.each([
    ['light', '#123456', 'monitor'],
    ['dark', '#abcdef', 'book-open'],
  ])('applies %s output icons and colors and removes overrides when reset to automatic', (mode, color, icon) => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    const styles = parseSettings({
      outputToggleStyles: {
        light: { icon: 'monitor', overrideColor: true, color: '#123456' },
        dark: { icon: 'book', overrideColor: true, color: '#abcdef' },
      },
    }).outputToggleStyles;
    const tools = commandTools(document, 'pwd', false, styles, () => {});
    tools.style.setProperty('--text-muted', 'rgb(100, 110, 120)');
    const button = tools.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    const previousClass = document.body.className;
    document.body.className = `theme-${mode}`;
    document.head.append(stylesheet);
    document.body.append(tools);
    try {
      const visible = button.querySelector(`.motto-output-icon-${mode}`)!;
      const hidden = button.querySelector(`.motto-output-icon-${mode === 'light' ? 'dark' : 'light'}`)!;
      expect(getComputedStyle(visible).display).toBe('inline-flex');
      expect(getComputedStyle(hidden).display).toBe('none');
      expect(visible.querySelector('svg')?.getAttribute('data-icon')).toBe(icon);
      expect(getComputedStyle(button).color).toBe(color);
      setOutputToggle(button, true, styles);
      expect(button.querySelector('.motto-output-icon-dark svg')?.getAttribute('data-icon')).toBe('book');
      setOutputToggle(button, true, DEFAULT_SETTINGS.outputToggleStyles);
      expect(button.style.getPropertyValue('--motto-output-light-color')).toBe('');
      expect(button.style.getPropertyValue('--motto-output-dark-color')).toBe('');
      expect(getComputedStyle(button).color).toBe(getComputedStyle(tools.querySelector('.motto-command-copy')!).color);
    } finally {
      tools.remove();
      stylesheet.remove();
      document.body.className = previousClass;
    }
  });

  it('renders colored terminal metadata safely and respects the shared header modes', () => {
    const block = parseCodeBlocks('```sh user:root host:server cwd:"/very/long/<img>" title:"Run"\npwd\n```').blocks[0]!;
    const header = createHeader(document, block, DEFAULT_SETTINGS)!;
    expect(header.classList.contains('motto-command-header')).toBe(true);
    expect(header.querySelector('.motto-terminal-icon')).not.toBeNull();
    expect(header.querySelector('.motto-command-context')?.textContent).toBe('root@server:/very/long/<img>');
    expect(header.querySelector('.motto-command-cwd')?.getAttribute('title')).toBe('/very/long/<img>');
    expect(header.querySelector('.motto-command-cwd img')).toBeNull();
    expect(createHeader(document, block, { ...DEFAULT_SETTINGS, headerDisplay: 'none' })).toBeNull();
    const ordinary = createHeader(document, block, { ...DEFAULT_SETTINGS, commandBlocks: false })!;
    expect(ordinary.querySelector('.motto-terminal-icon, .motto-command-context')).toBeNull();
  });

  it.each([
    ['default', 'js', false], ['default', '', false],
    ['default', 'js arbitrary custom:value', false],
    ['default', 'sh custom:"title:Run user:root fold"', false],
    ['default', 'sh title user host', false],
    ['default', 'sh custom:value title:Run', true],
    ['always', 'js arbitrary custom:value', true],
    ['default', 'sh cmd', false], ['default', 'bash COMMAND', false],
    ['default', 'sh cmd command', false], ['default', 'sh cmd title:Run', true],
    ['default', 'sh command user:root', true], ['always', 'sh cmd', true],
    ['none', 'sh command title:Run', false],
    ['default', 'js fold', true], ['default', 'js expand', true],
    ['default', 'js title:""', true], ['always', 'js', true],
    ['none', 'js title:Example fold', false],
    ['always', 'sh cmd exclude title:Ignored', false],
  ] as const)('uses %s visibility for %j', (headerDisplay, info, visible) => {
    const header = createHeader(document, { ...parseInfo(info), text: 'run()' }, {
      ...DEFAULT_SETTINGS, headerDisplay,
    });
    expect(header !== null).toBe(visible);
  });

  it.each([false, true])('keeps folding with labels disabled and header copying set to %s', (showHeaderCopyButton) => {
    const toggle = vi.fn();
    const header = createHeader(document, { ...parseInfo('js'), text: 'run()' }, {
      ...DEFAULT_SETTINGS, headerDisplay: 'always', showIcon: false, showLanguage: false, showHeaderCopyButton,
    }, { state: 'expanded', toggle })!;
    expect(header.children).toHaveLength(1);
    expect(header.querySelector('.motto-header-copy') !== null).toBe(showHeaderCopyButton);
    header.querySelector<HTMLButtonElement>('.motto-header-toggle')!.click();
    expect(toggle).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'warning'])('switches translucent label styles with the theme and settings for %j', (headerStyle) => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    const previousClass = document.body.className;
    document.head.append(stylesheet);
    const header = createHeader(document, {
      language: 'python', title: 'main.py', text: '', hasParameters: true, ...(headerStyle ? { headerStyle } : {}),
    }, DEFAULT_SETTINGS)!;
    document.body.append(header);
    const label = header.querySelector<HTMLElement>('.motto-header-language')!;
    try {
      document.body.className = 'theme-light';
      expect(getComputedStyle(label).backgroundColor).toBe('rgba(0, 0, 0, 0.1)');
      document.body.className = 'theme-dark';
      expect(getComputedStyle(label).backgroundColor).toBe('rgba(255, 255, 255, 0.1)');
      applyHeaderStyles(header, {
        light: { ...DEFAULT_SETTINGS.headerStyles.light, languageLabel: 'emphasized' },
        dark: DEFAULT_SETTINGS.headerStyles.dark,
      });
      expect(getComputedStyle(label).backgroundColor).toBe('rgba(255, 255, 255, 0.1)');
      document.body.className = 'theme-light';
      expect(getComputedStyle(label).backgroundColor).toBe('rgba(0, 0, 0, 0.65)');
      expect(getComputedStyle(label).color).toBe('#ffffff');
      applyHeaderStyles(header, DEFAULT_SETTINGS.headerStyles);
      expect(getComputedStyle(label).backgroundColor).toBe('rgba(0, 0, 0, 0.1)');
      expect(header.querySelector('.motto-header-language')).toBe(label);
    } finally {
      header.remove();
      stylesheet.remove();
      document.body.className = previousClass;
    }
  });

  it('supports mouse and keyboard fold activation without repeating held keys', () => {
    const toggle = vi.fn();
    const header = createHeader(document, { language: 'python', title: 'main.py', text: '', hasParameters: true }, DEFAULT_SETTINGS, {
      state: 'folded', toggle,
    })!;
    const fold = header.querySelector<HTMLButtonElement>('.motto-header-toggle')!;
    expect(header.getAttribute('role')).toBe('group');
    expect(fold.tabIndex).toBe(0);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.getAttribute('aria-label')).toContain('main.py');
    header.querySelector<HTMLElement>('.motto-header-language')!.click();
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    const space = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    header.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(true);
    header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true }));
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    header.dispatchEvent(new MouseEvent('click', { button: 2 }));
    expect(toggle).toHaveBeenCalledTimes(3);
  });

  it.each(['expanded', 'folded', 'partial'] as const)('copies the complete source in the %s state without folding', async (state) => {
    const text = 'first()\n\n  last()\n';
    let finishCopy!: () => void;
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(new Promise<void>((resolve) => {
      finishCopy = resolve;
    }));
    const toggle = vi.fn();
    const header = createHeader(document, { language: 'sh', title: 'Run', text, hasParameters: true }, {
      ...DEFAULT_SETTINGS, showHeaderCopyButton: true,
    }, {
      state, toggle,
    })!;
    const copy = header.querySelector<HTMLButtonElement>('.motto-header-copy')!;
    const fold = header.querySelector<HTMLButtonElement>('.motto-header-toggle')!;
    expect([...copy.parentElement!.children]).toEqual([copy, fold]);
    expect(copy.closest('[role="button"]')).toBeNull();
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      copy.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    copy.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(Notice.messages).toEqual([]);
    finishCopy();
    await Promise.resolve();
    expect(write).toHaveBeenCalledExactlyOnceWith(text);
    expect(Notice.messages).toEqual(['Copied to your clipboard']);
    expect(toggle).not.toHaveBeenCalled();
    expect(header.dataset.foldState).toBe(state);
  });

  it('reports clipboard failures without changing the folded state', async () => {
    const error = new Error('Clipboard permission denied');
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const toggle = vi.fn();
    const header = createHeader(document, { language: 'js', title: '', text: 'run()', hasParameters: true }, {
      ...DEFAULT_SETTINGS, showHeaderCopyButton: true,
    }, {
      state: 'folded', toggle,
    })!;
    header.querySelector<HTMLButtonElement>('.motto-header-copy')!.click();
    await vi.waitFor(() => expect(Notice.messages).toEqual(['Motto Code Block: Failed to copy code block.']));
    expect(log).toHaveBeenCalledWith('[Motto Code Block] Failed to copy code block.', error);
    expect(toggle).not.toHaveBeenCalled();
    expect(header.dataset.foldState).toBe('folded');
  });

  it('renders the icon, language badge, and title in CC order without interpreting HTML', () => {
    const title = '<img src=x onerror=alert(1)> **not Markdown**';
    const header = createHeader(document, { language: 'ts', title, text: '', hasParameters: true }, DEFAULT_SETTINGS)!;
    expect([...header.children].map((element) => element.className)).toEqual([
      'motto-header-icon', 'motto-header-language', 'motto-header-title', 'motto-header-controls',
    ]);
    expect(header.querySelector('.motto-header-language')?.textContent).toBe('TypeScript');
    expect(header.querySelector('.motto-header-title')?.textContent).toBe(title);
    expect(header.querySelector('.motto-header-title')?.getAttribute('title')).toBe(title);
    expect(header.querySelector('.motto-header-title')?.childElementCount).toBe(0);
    expect(header.querySelector('img[onerror]')).toBeNull();
    expect(header.querySelector('.motto-header-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each([
    ['python', 'Python', languages.python.icon],
    ['py', 'Python', languages.python.icon],
    ['JS', 'JavaScript', languages.javascript.icon],
    ['bash', 'Shell', languages.shell.icon],
    ['sh', 'Shell', languages.shell.icon],
    ['', 'Plain text', languages.plaintext.icon],
    ['c++', 'C++', languages.cpp.icon],
  ])('uses the bundled language logo for %s', (language, label, icon) => {
    const header = createHeader(document, { language, title: '', text: '', hasParameters: false }, {
      ...DEFAULT_SETTINGS, headerDisplay: 'always',
    })!;
    expect(header.querySelector('.motto-header-language')?.textContent).toBe(label);
    const image = header.querySelector('img')!;
    expect(image.getAttribute('src')).toBe(icon);
    expect(image.alt).toBe('');
    expect(header.querySelector('.motto-header-icon svg')).toBeNull();
  });

  it.each([
    ['custom-language', 'Custom-language'],
    ['constructor', 'Constructor'],
    ['abnf', 'ABNF'],
  ])('keeps a standard icon fallback for %s', (language, label) => {
    const header = createHeader(document, { language, title: '', text: '', hasParameters: false }, {
      ...DEFAULT_SETTINGS, headerDisplay: 'always',
    })!;
    expect(header.querySelector('.motto-header-language')?.textContent).toBe(label);
    expect(header.querySelector('img')).toBeNull();
    expect(header.querySelector('svg')?.getAttribute('data-icon')).toBe('file-code');
  });

  it('preserves CC precedence where its two alias tables disagree', () => {
    expect(languagePresentation('tex').label).toBe('TeX');
    expect(languagePresentation('gitignore').label).toBe('.gitignore');
    expect(languagePresentation('sqf').label).toBe('SQF: Status Quo Function (Arma 3)');
  });

  it('supports a title-only header and omits unmarked or disabled headers', () => {
    const settings = { ...DEFAULT_SETTINGS, showIcon: false, showLanguage: false };
    const header = createHeader(document, { language: 'js', title: 'Title', text: '', hasParameters: true }, settings)!;
    expect(header.children).toHaveLength(2);
    expect(header.textContent).toBe('Title');
    expect(createHeader(document, { language: 'js', title: '', text: '', hasParameters: false }, settings)).toBeNull();
    expect(createHeader(document, { language: 'js', title: 'Title', text: '', hasParameters: true }, {
      ...settings, headerDisplay: 'none',
    })).toBeNull();
  });

  it('confines native callout styling to an accessible-hidden background after the title', () => {
    const settings = { ...DEFAULT_SETTINGS, showIcon: false, showLanguage: false };
    const header = createHeader(document, {
      language: 'js', title: 'Title', text: '', hasParameters: true, headerStyle: 'warning',
    }, settings)!;
    expect(header.classList.contains('callout')).toBe(false);
    expect(header.dataset.headerStyle).toBe('warning');
    expect(header.firstElementChild?.className).toBe('motto-header-title');
    const background = header.querySelector<HTMLElement>('.motto-header-background')!;
    expect(background.classList.contains('callout')).toBe(true);
    expect(background.dataset.callout).toBe('warning');
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(background.childElementCount).toBe(0);
    expect(header.textContent).toBe('Title');
  });
});
