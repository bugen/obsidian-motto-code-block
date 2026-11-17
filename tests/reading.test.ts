// @vitest-environment happy-dom
import type { MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadingHeaders } from '../src/reading';
import { DEFAULT_SETTINGS, parseSettings, type MottoSettings } from '../src/settings';

const renderers: ReadingHeaders[] = [];

function fixture(source: string, initialSettings: MottoSettings = DEFAULT_SETTINGS) {
  let settings = { ...initialSettings };
  const children: MarkdownRenderChild[] = [];
  let currentSource = source;
  const readSource = vi.fn(async () => currentSource);
  const renderer = new ReadingHeaders(readSource, () => settings);
  renderers.push(renderer);
  const context: MarkdownPostProcessorContext = {
    docId: 'document-1',
    sourcePath: 'note.md',
    frontmatter: null,
    getSectionInfo: () => ({ text: currentSource, lineStart: 0, lineEnd: currentSource.split('\n').length - 1 }),
    addChild(child) { children.push(child); child.load(); },
  };
  return {
    renderer, context, children, readSource,
    updateSource(value: string) { currentSource = value; },
    updateSettings(value: typeof settings) { settings = value; renderer.refresh(); },
  };
}

function block(content: string, language = 'js') {
  const section = document.createElement('section');
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (language) code.className = `language-${language}`;
  const token = document.createElement('span');
  token.className = 'token keyword';
  token.textContent = `${content}\n`;
  code.append(token);
  const copy = document.createElement('button');
  copy.className = 'copy-code-button';
  pre.append(code, copy);
  section.append(pre);
  document.body.append(section);
  return { section, pre, code, token, copy };
}

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('reading mode headers', () => {
  it.each(['js', 'ansi', 'bash', 'my-language', ''])(
    'leaves excluded %j blocks untouched and applies language changes to mounted blocks', async (language) => {
      const name = language || 'plaintext';
      const settings = parseSettings({ languageWhitelist: [] });
      const { renderer, context, updateSettings } = fixture(
        `\`\`\`${language} title:Test expand:1${language === 'bash' ? ' user:root' : ''}\nfirst\nsecond\n\`\`\``,
        settings,
      );
      const native = block('first\nsecond', language);
      native.pre.classList.add('foreign-codeblock');
      const before = native.section.innerHTML;
      await renderer.process(native.section, context);
      expect(native.section.innerHTML).toBe(before);
      updateSettings({ ...settings, languageWhitelist: [name] });
      expect(native.section.querySelector('.motto-header')).not.toBeNull();
      expect(native.section.querySelector('.motto-expand-button')).not.toBeNull();
      updateSettings({ ...settings, languageWhitelist: [name], languageBlacklist: [name] });
      expect(native.section.querySelector('[class*="motto-"]')).toBeNull();
      expect(native.pre.hidden).toBe(false);
      expect(native.pre.classList.contains('foreign-codeblock')).toBe(true);
      expect(native.code.firstChild).toBe(native.token);
      expect(native.pre.querySelector('.copy-code-button')).toBe(native.copy);
      updateSettings({ ...settings, languageWhitelist: [name] });
      expect(native.section.querySelector('.motto-header')).not.toBeNull();
      expect(native.section.querySelector('.motto-expand-button')).not.toBeNull();
      expect(native.code.textContent).toBe('first\nsecond\n');
    },
  );

  it.each([
    ['sh', ''], ['sh', ' user:root'], ['ansi', ''], ['ansi', ' user:root'],
  ])('rebuilds output pairing when excluding %s with metadata %j', async (excluded, metadata) => {
    const settings = parseSettings({ languageBlacklist: [excluded] });
    const { renderer, context, updateSettings } = fixture(
      `\`\`\`sh title:Command${metadata}\npwd\nwhoami\n\`\`\`\n\`\`\`ansi\n/srv\nroot\n\`\`\``, settings,
    );
    const shell = block('pwd\nwhoami', 'sh');
    const ansi = block('/srv\nroot', 'ansi');
    await renderer.process(shell.section, context);
    await renderer.process(ansi.section, context);
    const checkExcluded = () => {
      expect(shell.section.querySelector('.motto-output-toggle')).toBeNull();
      expect(ansi.section.querySelector('.motto-command-output')).toBeNull();
      if (excluded === 'sh') {
        expect(shell.section.querySelector('[class*="motto-"]')).toBeNull();
        expect(ansi.section.querySelector('.motto-ansi-standalone')).not.toBeNull();
      } else {
        expect(ansi.section.querySelector('[class*="motto-"]')).toBeNull();
        expect(shell.section.querySelector('.motto-command-prompt') !== null).toBe(Boolean(metadata));
        expect(ansi.pre.hidden).toBe(false);
      }
    };
    checkExcluded();
    updateSettings(DEFAULT_SETTINGS);
    shell.section.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    expect(ansi.section.querySelector('.motto-command-output code')?.textContent).toBe('/srv\nroot');
    updateSettings(settings);
    checkExcluded();
    expect(shell.code.firstChild).toBe(shell.token);
    expect(ansi.code.firstChild).toBe(ansi.token);
    expect(ansi.code.textContent).toBe('/srv\nroot\n');
  });

  it.each(['pwd', ''])('refreshes independent output styles without closing output for command %j', async (command) => {
    const { renderer, context, updateSettings } = fixture(`\`\`\`sh\n${command}\n\`\`\`\n\`\`\`ansi\n/srv\n\`\`\``);
    const shell = block(command, 'sh');
    const ansi = block('/srv', 'ansi');
    await renderer.process(shell.section, context);
    await renderer.process(ansi.section, context);
    shell.section.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    updateSettings(parseSettings({
      outputToggleStyles: {
        light: { icon: 'monitor', reverseIcons: true, overrideColor: true, color: '#123456' },
        dark: { icon: 'hippo', reverseIcons: true, overrideColor: true, color: '#abcdef' },
      },
    }));
    const toggle = shell.section.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.querySelector('.motto-output-icon-light svg')?.getAttribute('data-icon')).toBe('monitor');
    expect(toggle.querySelector('.motto-output-icon-dark .motto-output-hippo')).not.toBeNull();
    expect(toggle.querySelector('.motto-output-hippo-flipped')).toBeNull();
    expect(toggle.style.getPropertyValue('--motto-output-light-color')).toBe('#123456');
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(false);
    toggle.click();
    expect(toggle.querySelector('.motto-output-icon-dark .motto-output-hippo-flipped')).not.toBeNull();
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(true);
    expect(shell.code.firstChild).toBe(shell.token);
    expect(shell.code.textContent).toBe(`${command}\n`);
  });

  it.each(['XXXXXXXXXXXX', '\x1b[32mXXXXXXXXXXXX\x1b[0m'])(
    'renders titled standalone ANSI while retaining the original DOM: %j', async (content) => {
      const { renderer, context, children } = fixture(`\`\`\`ansi title:テスト\n${content}\n\`\`\``, {
        ...DEFAULT_SETTINGS, showHeaderCopyButton: true,
      });
      const native = block(content, 'ansi');
      const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
      await renderer.process(native.section, context);
      expect(native.section.querySelector('.motto-header-title')?.textContent).toBe('テスト');
      expect(native.section.querySelector('.motto-ansi-standalone code')?.textContent).toBe('XXXXXXXXXXXX');
      expect(native.section.querySelector('.motto-command-output, .motto-command-prompt, .motto-output-toggle')).toBeNull();
      expect(native.code.firstChild).toBe(native.token);
      expect(native.code.textContent).toBe(`${content}\n`);
      native.section.querySelector<HTMLButtonElement>('.motto-header-copy')!.click();
      expect(write).toHaveBeenLastCalledWith(content);
      native.section.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
      expect(write).toHaveBeenLastCalledWith('XXXXXXXXXXXX');
      await renderer.process(native.section, context);
      expect(children).toHaveLength(1);
      expect(native.section.querySelectorAll('.motto-ansi-standalone')).toHaveLength(1);
      expect(native.section.querySelectorAll('.motto-header')).toHaveLength(1);
      renderer.destroy();
      expect(native.section.querySelector('.motto-ansi-view, .motto-header')).toBeNull();
      expect(native.pre.classList.contains('motto-command-native')).toBe(false);
      expect(native.code.firstChild).toBe(native.token);
      expect(native.pre.querySelector('.copy-code-button')).toBe(native.copy);
    },
  );

  it('renders headerless standalone ANSI independently of the command setting and honors whole folding', async () => {
    const settings: MottoSettings = { ...DEFAULT_SETTINGS, commandBlocks: false, headerDisplay: 'none' };
    const { renderer, context, updateSettings } = fixture('```ansi title:Log fold\nfirst\nsecond\n```', settings);
    const native = block('first\nsecond', 'ansi');
    await renderer.process(native.section, context);
    expect(native.section.querySelector('.motto-header')).toBeNull();
    expect(native.section.querySelector('.motto-ansi-standalone code')?.textContent).toBe('first\nsecond');
    expect(native.section.querySelectorAll('.motto-ansi-standalone .motto-line-number')).toHaveLength(2);
    updateSettings({ ...settings, headerDisplay: 'default' });
    expect(native.section.querySelector('.motto-header')?.getAttribute('data-fold-state')).toBe('folded');
    expect(native.section.querySelector('.motto-ansi-standalone')).toBeNull();
    expect(native.pre.classList.contains('motto-command-native')).toBe(true);
    native.section.querySelector<HTMLElement>('.motto-header')!.click();
    expect(native.section.querySelector('.motto-ansi-standalone code')?.textContent).toBe('first\nsecond');
  });

  it('applies partial previews and line numbers to standalone ANSI and copies the full plain text', async () => {
    const content = '\x1b[31mfirst\nsecond\nthird\x1b[0m';
    const { renderer, context } = fixture(`\`\`\`ansi title:Log expand:1\n${content}\n\`\`\``);
    const native = block(content, 'ansi');
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await renderer.process(native.section, context);
    const preview = native.section.querySelector<HTMLElement>('.motto-ansi-standalone pre')!;
    expect(preview.classList.contains('motto-partial-codeblock')).toBe(true);
    expect(preview.style.getPropertyValue('--motto-preview-lines')).toBe('1');
    expect([...preview.querySelectorAll('.motto-line-number')].map((node) => node.textContent)).toEqual(['1']);
    expect(native.pre.querySelector('.motto-line-number')).toBeNull();
    native.section.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith('first\nsecond\nthird');
    native.section.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(native.section.querySelector('.motto-partial-codeblock, .motto-expand-button')).toBeNull();
    expect(native.section.querySelectorAll('.motto-line-number')).toHaveLength(3);
    expect(native.code.textContent).toBe(`${content}\n`);
  });

  it('renders commands with native highlighting, lazy ANSI output and independent copies', async () => {
    const commands = 'pwd\nprintf \\\n  "hello"';
    const output = '\x1b[32mUNIQUE OUTPUT\x1b[0m';
    const { renderer, context, children, updateSettings } = fixture(
      `\`\`\`sh user:root host:server cwd:/srv/app\n${commands}\n\`\`\`\n\`\`\`ansi\n${output}\n\`\`\``,
      { ...DEFAULT_SETTINGS, showHeaderCopyButton: true },
    );
    const shell = block(commands, 'sh');
    const ansi = block(output, 'ansi');
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await renderer.process(shell.section, context);
    await renderer.process(ansi.section, context);
    expect(shell.section.querySelector('.motto-command-context')?.textContent).toBe('root@server:/srv/app');
    expect([...shell.section.querySelectorAll('.motto-command-prompt')].map((node) => node.textContent)).toEqual(['#', '#']);
    expect(shell.section.querySelectorAll('.motto-command-row .token')).toHaveLength(2);
    expect(shell.section.querySelector('.motto-line-number')).toBeNull();
    expect(shell.code.firstChild).toBe(shell.token);
    expect(shell.pre.querySelector('.copy-code-button')).toBe(shell.copy);
    expect(ansi.section.querySelector('.motto-command-output')).toBeNull();
    expect(ansi.pre.classList.contains('motto-command-native')).toBe(true);
    const copies = shell.section.querySelectorAll<HTMLButtonElement>('.motto-command-copy');
    copies[1]!.click();
    expect(write).toHaveBeenLastCalledWith('printf \\\n  "hello"');
    shell.section.querySelector<HTMLButtonElement>('.motto-header-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(commands);
    const toggle = shell.section.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.focus();
    toggle.click();
    expect(document.activeElement).toBe(toggle);
    const visual = ansi.section.querySelector<HTMLElement>('.motto-command-output')!;
    expect(visual.querySelector('code')?.textContent).toBe('UNIQUE OUTPUT');
    expect(visual.querySelector('code span')?.getAttribute('style')).toContain('color');
    visual.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith('UNIQUE OUTPUT');
    toggle.click();
    expect(visual.hidden).toBe(true);
    toggle.click();
    expect(ansi.section.querySelector('.motto-command-output')).toBe(visual);
    await renderer.process(shell.section, context);
    expect(children).toHaveLength(2);
    updateSettings({ ...DEFAULT_SETTINGS, headerDisplay: 'none' });
    expect(shell.section.querySelector('.motto-header, .motto-terminal-icon')).toBeNull();
    expect([...shell.section.querySelectorAll('.motto-command-prompt')].map((node) => node.textContent)).toEqual(['#', '#']);
    for (const child of children) child.unload();
    expect(shell.section.querySelector('.motto-command-view')).toBeNull();
    expect(shell.code.firstChild).toBe(shell.token);
    expect(shell.pre.classList.contains('motto-command-native')).toBe(false);
    expect(ansi.pre.classList.contains('motto-command-native')).toBe(false);
    expect(ansi.code.textContent).toBe(`${output}\n`);
  });

  it.each(['expand', 'unfold'])('pairs separately rendered output-first sections and honors ANSI %s', async (option) => {
    const { renderer, context, children } = fixture(`\`\`\`sh\npwd\n\`\`\`\n\`\`\`ansi ${option}\n/srv/app\n\`\`\``);
    const shell = block('pwd', 'sh');
    const ansi = block('/srv/app', 'ansi');
    await renderer.process(ansi.section, context);
    expect(ansi.section.querySelector('.motto-ansi-standalone code')?.textContent).toBe('/srv/app');
    await renderer.process(shell.section, context);
    expect(ansi.section.querySelector('.motto-header')).toBeNull();
    expect(ansi.section.querySelector('.motto-ansi-standalone')).toBeNull();
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(false);
    expect(shell.section.querySelector('.motto-header, .motto-terminal-icon')).toBeNull();
    expect(shell.section.querySelector('.motto-command-prompt')?.textContent).toBe('$');
    children[1]!.unload();
    expect(ansi.section.querySelector('.motto-command-output')).toBeNull();
    expect(ansi.section.querySelector('.motto-ansi-standalone code')?.textContent).toBe('/srv/app');
  });

  it.each([4, 5, 6])('previews up to five paired ANSI lines without a header (%s output lines)', async (count) => {
    const text = ['first', '', 'third', 'fourth', 'fifth', 'sixth'].slice(0, count).join('\n');
    const content = `\x1b[31m${text}\x1b[0m`;
    const { renderer, context } = fixture(`\`\`\`bash\npwd\n\`\`\`\n\`\`\`ansi expand:5\n${content}\n\`\`\``, {
      ...DEFAULT_SETTINGS, headerDisplay: 'none',
    });
    const shell = block('pwd', 'bash');
    const ansi = block(content, 'ansi');
    await renderer.process(shell.section, context);
    await renderer.process(ansi.section, context);
    const output = ansi.section.querySelector<HTMLElement>('.motto-command-output')!;
    expect(output.hidden).toBe(false);
    expect(output.querySelector('code')?.textContent).toBe(text);
    expect(output.querySelector('.motto-partial-codeblock') !== null).toBe(count > 5);
    expect(output.querySelector('.motto-expand-button') !== null).toBe(count > 5);
    expect(output.querySelectorAll('.motto-line-number')).toHaveLength(0);
    if (count > 5) {
      expect(output.querySelector('pre')?.style.getPropertyValue('--motto-preview-lines')).toBe('5');
      expect(output.querySelector('.motto-expand-button')?.textContent).toBe('Show all (1 more line)');
      output.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
      expect(ansi.section.querySelector('.motto-partial-codeblock')).toBeNull();
      shell.section.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(ansi.section.querySelector<HTMLElement>('.motto-partial-codeblock')?.style.getPropertyValue('--motto-preview-lines')).toBe('5');
      expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(false);
    } else {
      shell.section.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(output.hidden).toBe(true);
    }
    expect(shell.section.querySelector('.motto-header')).toBeNull();
  });

  it.each(['expand', 'unfold'])('returns fully expanded output to its %s preview and resets changed counts', async (option) => {
    const text = 'first\nsecond\nthird\nfourth';
    const source = `\`\`\`sh\npwd\n\`\`\`\n\`\`\`ansi ${option}:2\n\x1b[32m${text}\x1b[0m\n\`\`\``;
    const { renderer, context, updateSettings, updateSource } = fixture(source);
    const shell = block('pwd', 'sh');
    const ansi = block(`\x1b[32m${text}\x1b[0m`, 'ansi');
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const process = async () => {
      await renderer.process(shell.section, context);
      await renderer.process(ansi.section, context);
    };
    const toggle = () => shell.section.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    const preview = () => ansi.section.querySelector<HTMLElement>('.motto-partial-codeblock');
    await process();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    ansi.section.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(text);
    toggle();
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(true);
    toggle();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    ansi.section.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(preview()).toBeNull();
    expect(ansi.section.querySelector('.motto-expand-button')).toBeNull();
    updateSettings(parseSettings({ headerDisplay: 'none', outputToggleStyles: { light: { icon: 'hippo' } } }));
    expect(preview()).toBeNull();
    toggle();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(false);
    expect(shell.section.querySelector('.motto-output-toggle')?.getAttribute('aria-expanded')).toBe('true');
    toggle();
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(true);
    toggle();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(false);
    ansi.section.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(preview()).toBeNull();
    updateSource(source.replace(`${option}:2`, `${option}:1`));
    await process();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('1');
    expect(ansi.code.textContent).toBe(`\x1b[32m${text}\x1b[0m\n`);
    renderer.destroy();
    expect(ansi.section.querySelector('.motto-command-output, .motto-expand-button')).toBeNull();
    expect(ansi.pre.classList.contains('motto-command-native')).toBe(false);
  });

  it('does not toggle output while copying or selecting text and keeps standalone ANSI when commands are disabled', async () => {
    const { renderer, context, updateSettings } = fixture('```sh\npwd\n```\n```ansi\n/srv\n```');
    const shell = block('pwd', 'sh');
    const ansi = block('/srv', 'ansi');
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await renderer.process(shell.section, context);
    await renderer.process(ansi.section, context);
    const row = shell.section.querySelector<HTMLElement>('.motto-command-row')!;
    const toggle = shell.section.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    row.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    document.getSelection()!.selectAllChildren(row.querySelector('code')!);
    row.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    document.getSelection()!.removeAllRanges();
    row.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    updateSettings({ ...DEFAULT_SETTINGS, commandBlocks: false });
    expect(shell.section.querySelector('.motto-command-view')).toBeNull();
    expect(ansi.section.querySelector('.motto-command-output')).toBeNull();
    expect(shell.pre.classList.contains('motto-command-native')).toBe(false);
    expect(ansi.section.querySelector('.motto-ansi-standalone code')?.textContent).toBe('/srv');
    expect(shell.code.firstChild).toBe(shell.token);
  });

  it('hides paired output during a command partial preview and refreshes native token clones', async () => {
    const { renderer, context } = fixture('```sh user:root expand:1\npwd\nuname\n```\n```ansi expand\nLinux\n```');
    const shell = block('pwd\nuname', 'sh');
    const ansi = block('Linux', 'ansi');
    await renderer.process(shell.section, context);
    await renderer.process(ansi.section, context);
    expect(shell.section.querySelectorAll('.motto-command-row')).toHaveLength(1);
    expect(ansi.section.querySelector('.motto-command-output')).toBeNull();
    shell.section.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(false);
    shell.token.className = 'token function';
    shell.token.replaceChildren(document.createTextNode('pwd\nuname\n'));
    await vi.waitFor(() => {
      expect(shell.section.querySelectorAll('.motto-command-row .token.function')).toHaveLength(2);
    });
    shell.section.querySelector<HTMLElement>('.motto-header')!.click();
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(true);
  });

  it('restores a command view after an asynchronous native highlighter temporarily changes its text', async () => {
    const { renderer, context } = fixture('```sh user:root\npwd\n```');
    const shell = block('pwd', 'sh');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await renderer.process(shell.section, context);
    shell.token.textContent = '';
    await vi.waitFor(() => {
      expect(shell.section.querySelector<HTMLElement>('.motto-command-view')?.hidden).toBe(true);
      expect(shell.pre.classList.contains('motto-command-native')).toBe(false);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Command content changed'));
    shell.token.textContent = 'pwd\n';
    await vi.waitFor(() => {
      expect(shell.section.querySelector<HTMLElement>('.motto-command-view')?.hidden).toBe(false);
      expect(shell.pre.classList.contains('motto-command-native')).toBe(true);
      expect(shell.section.querySelector('.motto-command-row code')?.textContent).toBe('pwd');
    });
  });

  it('resets changed output policies and renders standalone ANSI when pairing is broken', async () => {
    let source = '```sh user:root\npwd\n```\n```ansi expand:1\n/srv\n```';
    const { renderer, context, updateSource } = fixture(source);
    const shell = block('pwd', 'sh');
    const ansi = block('/srv', 'ansi');
    const process = async () => {
      await renderer.process(shell.section, context);
      await renderer.process(ansi.section, context);
    };
    await process();
    shell.section.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(true);
    source = source.replace('expand:1', 'expand:2');
    updateSource(source);
    await process();
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(false);
    source = source.replace('```\n```ansi', '```\n\n```ansi');
    updateSource(source);
    await process();
    expect(shell.section.querySelector('.motto-output-toggle')).toBeNull();
    expect(ansi.section.querySelector('.motto-command-output')).toBeNull();
    expect(ansi.section.querySelector('.motto-ansi-standalone code')?.textContent).toBe('/srv');
    source = source.replace('```\n\n```ansi', '```\n```ansi');
    updateSource(source);
    await process();
    expect(shell.section.querySelector('.motto-output-toggle')).not.toBeNull();
    expect(ansi.section.querySelector<HTMLElement>('.motto-command-output')?.hidden).toBe(false);
  });

  it('updates conditional headers on reused blocks while preserving native code and copy controls', async () => {
    const content = 'first()\nsecond()';
    const source = `\`\`\`js\n${content}\n\`\`\``;
    const settings: MottoSettings = { ...DEFAULT_SETTINGS, defaultFoldState: 'partial', partialFoldLines: 1 };
    const { renderer, context, updateSettings, updateSource } = fixture(source, settings);
    const native = block(content);
    const copied: string[] = [];
    native.copy.addEventListener('click', () => { copied.push(native.code.textContent ?? ''); });
    await renderer.process(native.section, context);
    const header = () => native.section.querySelector<HTMLElement>('.motto-header');
    expect(header()).toBeNull();
    expect(native.pre.classList.contains('motto-codeblock')).toBe(false);
    expect(native.pre.querySelectorAll('.motto-line-number')).toHaveLength(2);
    updateSettings({ ...settings, headerDisplay: 'always' });
    expect(header()?.dataset.foldState).toBe('partial');
    native.copy.click();
    expect(copied).toEqual([`${content}\n`]);
    updateSettings({ ...settings, headerDisplay: 'none' });
    expect(header()).toBeNull();
    expect(native.pre.classList.contains('motto-partial-codeblock')).toBe(false);
    expect(native.section.querySelector('.motto-expand-button')).toBeNull();
    updateSettings(settings);
    updateSource(`\`\`\`js title:""\n${content}\n\`\`\``);
    await renderer.process(native.section, context);
    expect(header()?.dataset.foldState).toBe('partial');
    updateSource(`\`\`\`js fold\n${content}\n\`\`\``);
    await renderer.process(native.section, context);
    expect(header()?.dataset.foldState).toBe('folded');
    updateSettings({ ...settings, headerDisplay: 'none' });
    expect(header()).toBeNull();
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
    updateSettings(settings);
    updateSource(source);
    await renderer.process(native.section, context);
    expect(header()).toBeNull();
    expect(native.pre.classList.contains('motto-partial-codeblock')).toBe(false);
    expect(native.code.firstChild).toBe(native.token);
    expect(native.code.textContent).toBe(`${content}\n`);
    expect(native.pre.querySelector('button')).toBe(native.copy);
  });

  it.each(['fold', 'expand:1'])('copies all source body lines from a %s header and updates reused blocks', async (option) => {
    const content = 'first()\n\nlast()\n';
    const { renderer, context, updateSource, updateSettings } = fixture(`\`\`\`js ${option}\n${content}\n\`\`\``);
    const native = block(content);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await renderer.process(native.section, context);
    const copy = () => native.section.querySelector<HTMLButtonElement>('.motto-header-copy')!;
    const state = native.section.querySelector<HTMLElement>('.motto-header')!.dataset.foldState;
    expect(native.section.querySelector('.motto-header-copy')).toBeNull();
    updateSettings({ ...DEFAULT_SETTINGS, showHeaderCopyButton: true });
    copy().click();
    expect(write).toHaveBeenLastCalledWith(content);
    expect(native.section.querySelector<HTMLElement>('.motto-header')!.dataset.foldState).toBe(state);
    const updated = content.replace('last()', 'changed()');
    updateSource(`\`\`\`js ${option}\n${updated}\n\`\`\``);
    native.token.textContent = `${updated}\n`;
    await renderer.process(native.section, context);
    copy().click();
    expect(write).toHaveBeenLastCalledWith(updated);
    expect(native.code.firstChild).toBe(native.token);
    expect(native.pre.querySelector('button')).toBe(native.copy);
    native.section.querySelector<HTMLElement>('.motto-header')!.click();
    updateSettings(DEFAULT_SETTINGS);
    expect(native.section.querySelector('.motto-header-copy')).toBeNull();
    expect(native.section.querySelector<HTMLElement>('.motto-header')!.dataset.foldState).toBe('expanded');
  });

  it.each([4, 5, 6])('clips only longer bodies and preserves native content with %i logical lines', async (count) => {
    const lines = ['a long wrapped line '.repeat(40), '', 'third()', 'fourth()', 'fifth()', 'last()'];
    const content = lines.slice(0, count).join('\n');
    const { renderer, context } = fixture(`\`\`\`js expand:5\n${content}\n\`\`\``);
    const native = block(content);
    await renderer.process(native.section, context);
    expect(native.pre.classList.contains('motto-partial-codeblock')).toBe(count > 5);
    expect(native.pre.querySelectorAll('.motto-line-number')).toHaveLength(Math.min(5, count));
    expect(native.section.querySelector('.motto-expand-button') !== null).toBe(count > 5);
    expect(native.section.querySelector('.motto-expand-footer > .motto-expand-button') !== null).toBe(count > 5);
    expect(native.code.firstChild).toBe(native.token);
    expect(native.code.textContent).toBe(`${content}\n`);
    expect(native.pre.querySelector('button')).toBe(native.copy);
  });

  it('supports partial/full toggles with or without numbers and preserves full native copy text', async () => {
    const content = 'first()\nsecond()\nthird()\nlast()';
    const { renderer, context, updateSettings, children } = fixture(`\`\`\`js expand:2\n${content}\n\`\`\``);
    const native = block(content);
    const copied: string[] = [];
    native.copy.addEventListener('click', () => { copied.push(native.code.textContent ?? ''); });
    await renderer.process(native.section, context);
    const header = () => native.section.querySelector<HTMLElement>('.motto-header')!;
    native.copy.click();
    header().click();
    expect(native.pre.classList.contains('motto-partial-codeblock')).toBe(false);
    updateSettings({ ...DEFAULT_SETTINGS, defaultFoldState: 'folded', partialFoldLines: 1, lineNumbers: 'none' });
    expect(header().dataset.foldState).toBe('expanded');
    header().click();
    expect(header().dataset.foldState).toBe('partial');
    expect(native.pre.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    expect(native.pre.querySelector('.motto-line-number')).toBeNull();
    native.section.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(header().dataset.foldState).toBe('expanded');
    expect(native.section.querySelector('.motto-expand-footer')).toBeNull();
    expect(native.pre.classList.contains('motto-partial-codeblock')).toBe(false);
    expect(native.pre.style.getPropertyValue('--motto-preview-lines')).toBe('');
    native.copy.click();
    expect(copied).toEqual([`${content}\n`, `${content}\n`]);
    header().click();
    children[0]!.unload();
    expect(native.section.querySelector('.motto-expand-footer, .motto-expand-button')).toBeNull();
    expect(native.pre.className).toBe('');
    expect(native.code.firstChild).toBe(native.token);
  });

  it('updates default preview lengths without overriding explicit choices and reveals blocks without headers', async () => {
    const content = 'first()\nsecond()\nthird()\nlast()';
    const source = ['fold', 'expand', 'expand:2', 'title:Default']
      .map((option) => `\`\`\`js ${option}\n${content}\n\`\`\``).join('\n\n');
    const { renderer, context, updateSettings } = fixture(source, {
      ...DEFAULT_SETTINGS, defaultFoldState: 'partial', partialFoldLines: 3,
    });
    const natives = [0, 1, 2, 3].map(() => block(content));
    for (const native of natives) await renderer.process(native.section, context);
    const states = () => natives.map(({ section }) => section.querySelector<HTMLElement>('.motto-header')?.dataset.foldState);
    expect(states()).toEqual(['folded', 'expanded', 'partial', 'partial']);
    updateSettings({ ...DEFAULT_SETTINGS, defaultFoldState: 'partial', partialFoldLines: 1 });
    expect(natives[2]!.pre.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    expect(natives[3]!.pre.style.getPropertyValue('--motto-preview-lines')).toBe('1');
    updateSettings({ ...DEFAULT_SETTINGS, defaultFoldState: 'partial', headerDisplay: 'none' });
    expect(natives.every(({ pre }) => !pre.classList.contains('motto-partial-codeblock'))).toBe(true);
    expect(document.querySelector('.motto-expand-button')).toBeNull();
  });

  it('reapplies a changed explicit preview length to a reused native block', async () => {
    const content = 'first()\nsecond()\nthird()\nlast()';
    const { renderer, context, updateSource } = fixture(`\`\`\`js expand:2\n${content}\n\`\`\``);
    const native = block(content);
    await renderer.process(native.section, context);
    native.section.querySelector<HTMLElement>('.motto-header')!.click();
    updateSource(`\`\`\`js expand:1\n${content}\n\`\`\``);
    await renderer.process(native.section, context);
    expect(native.pre.classList.contains('motto-partial-codeblock')).toBe(true);
    expect(native.pre.querySelectorAll('.motto-line-number')).toHaveLength(1);
    expect(native.code.textContent).toBe(`${content}\n`);
  });

  it.each(['expanded', 'folded'] as const)('prioritizes explicit folding options over the %s default', async (defaultFoldState) => {
    const source = ['fold', 'expand', 'unfold', 'title:Default']
      .map((option, index) => `\`\`\`js ${option}\nblock${index}()\n\`\`\``).join('\n\n');
    const { renderer, context } = fixture(source, { ...DEFAULT_SETTINGS, defaultFoldState });
    const natives = [0, 1, 2, 3].map((index) => block(`block${index}()`));
    for (const native of natives) await renderer.process(native.section, context);
    expect(natives.map(({ pre }) => pre.classList.contains('motto-codeblock-collapsed')))
      .toEqual([true, false, false, defaultFoldState === 'folded']);
    expect(natives.map(({ section }) => section.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')))
      .toEqual(['false', 'true', 'true', String(defaultFoldState === 'expanded')]);
    expect(natives.every(({ code, token, pre, copy }) => code.firstChild === token && pre.querySelector('button') === copy))
      .toBe(true);
  });

  it('updates untouched defaults while preserving manual overrides across reprocessing and refresh', async () => {
    const source = '```js title:First\nfirst()\n```\n\n```js title:Second\nsecond()\n```';
    const { renderer, context, updateSettings, updateSource } = fixture(source);
    const first = block('first()');
    const second = block('second()');
    await renderer.process(first.section, context);
    await renderer.process(second.section, context);
    first.section.querySelector<HTMLElement>('.motto-header')!.click();
    updateSettings({ ...DEFAULT_SETTINGS, defaultFoldState: 'folded' });
    expect(first.pre.classList.contains('motto-codeblock-collapsed')).toBe(true);
    expect(second.pre.classList.contains('motto-codeblock-collapsed')).toBe(true);
    first.section.querySelector<HTMLElement>('.motto-header')!.click();
    updateSource(`Intro\n\n${source}`);
    await renderer.process(first.section, context);
    await renderer.process(second.section, context);
    updateSettings({ ...DEFAULT_SETTINGS, defaultFoldState: 'folded', showIcon: false });
    expect(first.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
    expect(second.pre.classList.contains('motto-codeblock-collapsed')).toBe(true);
    updateSettings(DEFAULT_SETTINGS);
    expect(first.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
    expect(second.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
  });

  it('reapplies changed folding options without resetting manual state for unrelated edits', async () => {
    const { renderer, context, updateSource } = fixture('```js fold title:First\nrun()\n```');
    const native = block('run()');
    await renderer.process(native.section, context);
    native.section.querySelector<HTMLElement>('.motto-header')!.click();
    updateSource('```js fold title:Changed\nrun()\n```');
    await renderer.process(native.section, context);
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
    updateSource('```js expand title:Changed\nrun()\n```');
    await renderer.process(native.section, context);
    updateSource('```js fold title:Changed\nrun()\n```');
    await renderer.process(native.section, context);
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(true);
    updateSource('```js title:Changed\nrun()\n```');
    await renderer.process(native.section, context);
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
  });

  it('never hides initially folded code without a header and restores native content on unload', async () => {
    const { renderer, context, updateSettings, children } = fixture('```js fold\nrun()\n```');
    const native = block('run()');
    await renderer.process(native.section, context);
    updateSettings({ ...DEFAULT_SETTINGS, headerDisplay: 'none' });
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
    updateSettings({ ...DEFAULT_SETTINGS, showIcon: false, showLanguage: false });
    expect(native.section.querySelector('.motto-header-copy')).toBeNull();
    expect(native.section.querySelector('.motto-header-toggle')).not.toBeNull();
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(true);
    updateSettings(DEFAULT_SETTINGS);
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(true);
    children[0]!.unload();
    expect(native.pre.className).toBe('');
    expect(native.pre.querySelector('code')).toBe(native.code);
    expect(native.code.textContent).toBe('run()\n');
  });

  it('applies each mode to zero, one and two logical lines without changing native code', async () => {
    const single = 'a long single line '.repeat(40);
    const source = `\`\`\`js\n\`\`\`\n\n\`\`\`js\n${single}\n\`\`\`\n\n\`\`\`js\ntwo()\n\n\`\`\``;
    const { renderer, context, updateSettings } = fixture(source);
    const natives = [block(''), block(single), block('two()\n')];
    for (const native of natives) await renderer.process(native.section, context);
    for (const [lineNumbers, expected] of [
      ['default', [0, 0, 2]],
      ['always', [0, 1, 2]],
      ['none', [0, 0, 0]],
    ] as const) {
      updateSettings({ ...DEFAULT_SETTINGS, lineNumbers });
      expect(natives.map(({ pre }) => pre.querySelectorAll('.motto-line-number').length)).toEqual(expected);
      expect(natives.every(({ code, token }) => code.firstChild === token)).toBe(true);
      expect(natives[1]!.code.textContent).toBe(`${single}\n`);
    }
  });

  it('numbers blank and trailing body lines without modifying native code, highlighting or copy text', async () => {
    const { renderer, context, updateSettings, children } = fixture('```js title:Numbers\nfirst()\n\nlast()\n\n```');
    const native = block('first()\n\nlast()\n');
    const original = native.code.textContent;
    await renderer.process(native.section, context);
    const numbers = () => [...native.pre.querySelectorAll('.motto-line-number')].map((n) => n.textContent);
    expect(numbers()).toEqual(['1', '2', '3', '4']);
    expect(native.pre.querySelector('.motto-line-numbers')?.getAttribute('aria-hidden')).toBe('true');
    expect(native.pre.querySelector('.motto-line-numbers')?.parentElement).toBe(native.pre);
    expect(native.code.firstChild).toBe(native.token);
    expect(native.code.textContent).toBe(original);
    expect(native.pre.querySelector('button')).toBe(native.copy);
    updateSettings({ ...DEFAULT_SETTINGS, headerDisplay: 'none' });
    expect(numbers()).toEqual(['1', '2', '3', '4']);
    expect(native.section.querySelector('.motto-header')).toBeNull();
    updateSettings({ ...DEFAULT_SETTINGS, lineNumbers: 'none' });
    expect(numbers()).toEqual([]);
    expect(native.pre.classList.contains('motto-numbered-codeblock')).toBe(false);
    expect(native.pre.style.getPropertyValue('--motto-line-number-width')).toBe('');
    expect(native.section.querySelector('.motto-header')).not.toBeNull();
    updateSettings({ ...DEFAULT_SETTINGS });
    children[0]!.unload();
    expect(numbers()).toEqual([]);
    expect(native.code.firstChild).toBe(native.token);
    expect(native.code.textContent).toBe(original);
    expect(native.pre.className).toBe('');
  });

  it('does not add numbers to an empty block and refreshes the count on reused native code', async () => {
    const { renderer, context, updateSource } = fixture('```js\n```');
    const native = block('');
    await renderer.process(native.section, context);
    expect(native.pre.querySelector('.motto-line-number')).toBeNull();
    updateSource('```js\n\n```');
    await renderer.process(native.section, context);
    expect(native.pre.querySelector('.motto-line-number')).toBeNull();
    updateSource('```js\n\n\n```');
    native.token.textContent = '\n\n';
    await renderer.process(native.section, context);
    expect([...native.pre.querySelectorAll('.motto-line-number')].map((n) => n.textContent)).toEqual(['1', '2']);
    updateSource('```js\n\n```');
    native.token.textContent = '\n';
    await renderer.process(native.section, context);
    expect(native.pre.querySelector('.motto-line-number')).toBeNull();
    expect(native.pre.classList.contains('motto-numbered-codeblock')).toBe(false);
  });

  it('reserves a missing trailing blank row without adding characters to copied code', async () => {
    const { renderer, context, updateSettings } = fixture('```js\nfirst()\n\n\n```');
    const native = block('first()\n');
    await renderer.process(native.section, context);
    expect(native.pre.querySelectorAll('.motto-line-number')).toHaveLength(3);
    expect(native.pre.classList.contains('motto-trailing-empty-line')).toBe(true);
    expect(native.code.textContent).toBe('first()\n\n');
    native.token.textContent += '\n';
    await vi.waitFor(() => { expect(native.pre.classList.contains('motto-trailing-empty-line')).toBe(false); });
    expect(native.pre.querySelectorAll('.motto-line-number')).toHaveLength(3);
    updateSettings({ ...DEFAULT_SETTINGS, lineNumbers: 'none' });
    expect(native.pre.classList.contains('motto-trailing-empty-line')).toBe(false);
    expect(native.code.textContent).toBe('first()\n\n\n');
  });

  it('updates and removes header styles without replacing native code or copy controls', async () => {
    const { renderer, context, updateSource } = fixture('```js header-style:warning\nsame()\n```');
    const native = block('same()');
    await renderer.process(native.section, context);
    const background = () => native.section.querySelector<HTMLElement>('.motto-header-background');
    expect(background()?.dataset.callout).toBe('warning');
    updateSource('```js header-style:error\nsame()\n```');
    await renderer.process(native.section, context);
    expect(background()?.dataset.callout).toBe('error');
    updateSource('```js\nsame()\n```');
    await renderer.process(native.section, context);
    expect(background()).toBeNull();
    expect(native.pre.style.background).toBe('');
    expect(native.code.firstChild).toBe(native.token);
    expect(native.pre.querySelector('button')).toBe(native.copy);
  });

  it('refreshes per-mode appearance on folded blocks without changing the native pre', async () => {
    const { renderer, context, updateSettings } = fixture('```js file:main.js\nsame()\n```');
    const native = block('same()');
    await renderer.process(native.section, context);
    native.section.querySelector<HTMLElement>('.motto-header')!.click();
    updateSettings({
      ...DEFAULT_SETTINGS,
      headerStyles: {
        ...DEFAULT_SETTINGS.headerStyles,
        light: { ...DEFAULT_SETTINGS.headerStyles.light, titleBold: true, titleColor: '#abcdef', overrideTitleColor: true },
      },
    });
    const header = native.section.querySelector<HTMLElement>('.motto-header')!;
    expect(header.style.getPropertyValue('--motto-light-title-color')).toBe('#abcdef');
    expect(header.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(true);
    expect(native.pre.querySelector('code')).toBe(native.code);
    header.click();
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
    expect(native.code.firstChild).toBe(native.token);
  });

  it('toggles only the clicked block while preserving native code and copy controls', async () => {
    const { renderer, context } = fixture('```js title:First\nfirst()\n```\n\n```js title:Second\nsecond()\n```');
    const first = block('first()');
    const second = block('second()');
    await renderer.process(first.section, context);
    await renderer.process(second.section, context);
    const header = first.section.querySelector<HTMLElement>('.motto-header')!;
    header.querySelector<HTMLElement>('.motto-header-language')!.click();
    expect(header.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(first.pre.classList.contains('motto-codeblock-collapsed')).toBe(true);
    expect(second.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
    expect(first.code.firstChild).toBe(first.token);
    expect(first.pre.querySelector('button')).toBe(first.copy);
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(header.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(first.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
    expect(first.code.textContent).toBe('first()\n');
  });

  it('preserves folding on visual refresh but reveals code when controls are removed or unloaded', async () => {
    const { renderer, context, updateSettings, children } = fixture('```js file:main.js\nsame()\n```');
    const native = block('same()');
    await renderer.process(native.section, context);
    native.section.querySelector<HTMLElement>('.motto-header')!.click();
    updateSettings({ ...DEFAULT_SETTINGS, showIcon: false });
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(true);
    expect(native.section.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('false');
    updateSettings({ ...DEFAULT_SETTINGS, headerDisplay: 'none' });
    expect(native.pre.classList.contains('motto-codeblock-collapsed')).toBe(false);
    updateSettings({ ...DEFAULT_SETTINGS });
    const header = native.section.querySelector<HTMLElement>('.motto-header')!;
    expect(header.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('true');
    header.click();
    children[0]!.unload();
    expect(native.pre.className).toBe('');
    expect(native.pre.querySelector('code')).toBe(native.code);
  });

  it('preserves native code, highlighting, and copy controls across refresh and unload', async () => {
    const { renderer, context, updateSettings, children } = fixture('```js file:main.js\nconst n = 1;\n```');
    const native = block('const n = 1;');
    const copy = vi.fn();
    native.copy.addEventListener('click', copy);
    await renderer.process(native.section, context);
    await renderer.process(native.section, context);
    expect(native.section.querySelectorAll('.motto-header')).toHaveLength(1);
    expect(native.section.querySelector('.motto-header-title')?.textContent).toBe('main.js');
    expect(native.code.firstChild).toBe(native.token);
    native.copy.click();
    expect(copy).toHaveBeenCalledOnce();

    updateSettings({ ...DEFAULT_SETTINGS, showIcon: false, showLanguage: false });
    expect(native.section.querySelector('.motto-header')?.textContent).toBe('main.js');
    updateSettings({ ...DEFAULT_SETTINGS, headerDisplay: 'none' });
    expect(native.section.querySelector('.motto-header')).toBeNull();
    expect(native.pre.classList.contains('motto-codeblock')).toBe(false);
    updateSettings({ ...DEFAULT_SETTINGS });
    expect(native.section.querySelector('.motto-header')).not.toBeNull();
    children[0]!.unload();
    expect(native.section.querySelector('.motto-header')).toBeNull();
    expect(native.pre.className).toBe('');
    expect(native.pre.querySelector('code')).toBe(native.code);
    expect(native.code.firstChild).toBe(native.token);
    expect(native.pre.querySelector('button')).toBe(native.copy);
  });

  it('matches duplicate code in separate renders without reusing the first title', async () => {
    const { renderer, context } = fixture('```js title:First\nsame()\n```\n\n```js title:Second\nsame()\n```');
    const first = block('same()');
    const second = block('same()');
    await renderer.process(first.section, context);
    await renderer.process(second.section, context);
    await renderer.process(first.section, context);
    expect(first.section.querySelector('.motto-header-title')?.textContent).toBe('First');
    expect(second.section.querySelector('.motto-header-title')?.textContent).toBe('Second');
  });

  it('uses source ranges for out-of-order sections and handles a pre root', async () => {
    const { renderer, context } = fixture('```js title:First\nsame()\n```\n\n```js title:Second\nsame()\n```');
    const first = block('same()');
    const second = block('same()');
    const getSectionInfo = context.getSectionInfo;
    context.getSectionInfo = (element) => ({
      ...getSectionInfo(element)!,
      lineStart: element === second.code ? 4 : 0,
      lineEnd: element === second.code ? 6 : 2,
    });
    await renderer.process(second.pre, context);
    await renderer.process(first.pre, context);
    expect(first.pre.previousElementSibling?.textContent).toBe('JavaScriptFirst');
    expect(second.pre.previousElementSibling?.textContent).toBe('JavaScriptSecond');
  });

  it('does not decorate indented or independently rendered code', async () => {
    const { renderer, context } = fixture('    indented\n\n```js\nreal()\n```');
    const indented = block('indented', '');
    const external = block('generated()');
    await renderer.process(indented.section, context);
    await renderer.process(external.section, context);
    expect(document.querySelector('.motto-header')).toBeNull();
  });

  it('updates titles on a reused native block and removes a stale header when it is no longer fenced', async () => {
    const { renderer, context, updateSource } = fixture('```js title:First\nsame()\n```');
    const native = block('same()');
    await renderer.process(native.section, context);
    updateSource('```js title:Changed\nsame()\n```');
    await renderer.process(native.section, context);
    expect(native.section.querySelector('.motto-header-title')?.textContent).toBe('Changed');
    updateSource('    same()');
    await renderer.process(native.section, context);
    expect(native.section.querySelector('.motto-header')).toBeNull();
    expect(native.pre.classList.contains('motto-codeblock')).toBe(false);
  });

  it('does not mount an async result after the plugin is unloaded', async () => {
    let resolve: (value: string) => void = () => { throw new Error('Uninitialized source reader.'); };
    const pending = new Promise<string>((done) => { resolve = done; });
    const renderer = new ReadingHeaders(() => pending, () => DEFAULT_SETTINGS);
    const native = block('real()');
    const { context } = fixture('```js\nreal()\n```');
    const process = renderer.process(native.section, context);
    renderer.destroy();
    resolve('```js\nreal()\n```');
    await process;
    expect(document.querySelector('.motto-header')).toBeNull();
  });

  it('reports missing source positions and propagates source read failures', async () => {
    const { renderer, context, readSource } = fixture('```js\nreal()\n```');
    const native = block('real()');
    context.getSectionInfo = () => null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await renderer.process(native.section, context);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Source positions unavailable'));
    readSource.mockRejectedValueOnce(new Error('Read failed'));
    await expect(renderer.process(native.section, context)).rejects.toThrow('Read failed');
  });
});
