// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorHeaders } from '../src/editor';
import { DEFAULT_SETTINGS, parseSettings, type MottoSettings } from '../src/settings';
import { setLivePreview } from './obsidian';

const views: EditorView[] = [];
const source = 'Intro\n\n```ts file:main.ts\nconst n = 1;\n```\n\n```bash title:Install\nnpm install\n```';

function fixture(livePreview = true, doc = source, initialSettings: MottoSettings = DEFAULT_SETTINGS) {
  let settings = { ...initialSettings };
  const headers = createEditorHeaders(() => settings);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [editorLivePreviewField.init(() => livePreview), headers.extension],
    }),
    parent: document.body,
  });
  views.push(view);
  return {
    view, headers,
    updateSettings(value: typeof settings) { settings = value; headers.refresh(); },
  };
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('live preview headers', () => {
  it.each(['js', 'ansi', 'bash', 'my-language', ''])(
    'leaves excluded %j source and selection behavior alone and refreshes eligibility', (language) => {
      const name = language || 'plaintext';
      const doc = `Intro\n\n\`\`\`${language} title:Test expand:1${language === 'bash' ? ' user:root' : ''}\nfirst\nsecond\n\`\`\`\n\nAfter`;
      const settings = parseSettings({ languageWhitelist: [] });
      const { view, updateSettings } = fixture(true, doc, settings);
      expect(view.dom.querySelector('[class*="motto-"]')).toBeNull();
      updateSettings({ ...settings, languageWhitelist: [name] });
      expect(view.dom.querySelector('.motto-header')).not.toBeNull();
      expect(view.dom.querySelector('.motto-expand-button')).not.toBeNull();
      updateSettings({ ...settings, languageWhitelist: [name], languageBlacklist: [name] });
      expect(view.dom.querySelector('[class*="motto-"]')).toBeNull();
      expect(view.contentDOM.textContent).toContain('second');
      const from = doc.indexOf('first');
      view.dispatch({ selection: { anchor: from } });
      expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }), 'editor')).toBe(false);
      expect(view.state.selection.main.empty).toBe(true);
      view.dispatch({ selection: { anchor: 0 } });
      updateSettings({ ...settings, languageWhitelist: [name] });
      expect(view.dom.querySelector('.motto-header')).not.toBeNull();
      expect(view.dom.querySelector('.motto-expand-button')).not.toBeNull();
      view.dispatch({ effects: setLivePreview.of(false) });
      expect(view.dom.querySelector('[class*="motto-"]')).toBeNull();
      expect(view.state.doc.toString()).toBe(doc);
    },
  );

  it.each([
    ['sh', ''], ['sh', ' user:root'], ['ansi', ''], ['ansi', ' user:root'],
  ])('rebuilds output pairing when excluding %s with metadata %j', (excluded, metadata) => {
    const doc = `Intro\n\n\`\`\`sh title:Command${metadata}\npwd\nwhoami\n\`\`\`\n\`\`\`ansi\n/srv\nroot\n\`\`\``;
    const settings = parseSettings({ languageBlacklist: [excluded] });
    const { view, updateSettings } = fixture(true, doc, settings);
    const checkExcluded = () => {
      expect(view.dom.querySelector('.motto-output-toggle, .motto-command-output')).toBeNull();
      if (excluded === 'sh') {
        expect(view.dom.querySelector('.motto-command-prompt')).toBeNull();
        expect(view.dom.querySelector('.motto-ansi-standalone')).not.toBeNull();
        expect(view.contentDOM.textContent).toContain('```sh title:Command');
      } else {
        expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
        expect(view.dom.querySelector('.motto-command-prompt') !== null).toBe(Boolean(metadata));
        expect(view.contentDOM.textContent).toContain('```ansi');
      }
    };
    checkExcluded();
    updateSettings(DEFAULT_SETTINGS);
    view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('/srv\nroot');
    updateSettings(settings);
    checkExcluded();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['pwd', ''])('refreshes output appearance without losing state, focus or source for command %j', (command) => {
    const doc = `Intro\n\n\`\`\`sh\n${command}\n\`\`\`\n\`\`\`ansi\n/srv\n\`\`\``;
    const { view, updateSettings } = fixture(true, doc);
    const toggle = view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    toggle.focus();
    toggle.click();
    const settings = parseSettings({
      outputToggleStyles: {
        light: { icon: 'monitor', reverseIcons: true, overrideColor: true, color: '#123456' },
        dark: { icon: 'hippo', reverseIcons: true, overrideColor: true, color: '#abcdef' },
      },
    });
    updateSettings(settings);
    expect(view.dom.querySelector('.motto-output-toggle')).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.querySelector('.motto-output-icon-light svg')?.getAttribute('data-icon')).toBe('monitor');
    expect(toggle.querySelector('.motto-output-icon-dark .motto-output-hippo')).not.toBeNull();
    expect(toggle.querySelector('.motto-output-hippo-flipped')).toBeNull();
    expect(toggle.style.getPropertyValue('--motto-output-dark-color')).toBe('#abcdef');
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('/srv');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.querySelector('.motto-output-icon-dark .motto-output-hippo-flipped')).not.toBeNull();
    updateSettings(DEFAULT_SETTINGS);
    expect(toggle.style.getPropertyValue('--motto-output-dark-color')).toBe('');
    expect(toggle.querySelector('.motto-output-icon-light svg')?.getAttribute('data-icon')).toBe('eye');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('previews titled standalone ANSI and edits its source after preceding changes without altering source mode', () => {
    const content = '\x1b[32mXXXXXXXXXXXX\x1b[0m';
    const doc = `Intro\n\n\`\`\`ansi title:テスト\n${content}\n\`\`\``;
    const { view } = fixture(true, doc, { ...DEFAULT_SETTINGS, showHeaderCopyButton: true });
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    expect(view.dom.querySelector('.motto-header-title')?.textContent).toBe('テスト');
    expect(view.dom.querySelector('.motto-ansi-standalone code')?.textContent).toBe('XXXXXXXXXXXX');
    expect(view.contentDOM.textContent).not.toContain('```ansi');
    expect(view.dom.querySelector('.motto-header')?.nextElementSibling)
      .toBe(view.dom.querySelector('.motto-ansi-standalone'));
    expect(view.dom.querySelector('.motto-command-output, .motto-command-prompt, .motto-output-toggle')).toBeNull();
    view.dom.querySelector<HTMLButtonElement>('.motto-header-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(content);
    view.dom.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith('XXXXXXXXXXXX');
    view.dispatch({ changes: { from: 0, insert: 'Before\n\n' } });
    const edit = view.dom.querySelector<HTMLButtonElement>('.motto-output-tools button[aria-label="Edit source"]')!;
    expect(edit.textContent).toBe('');
    expect(edit.hasAttribute('title')).toBe(false);
    expect(edit.querySelector('svg')?.getAttribute('data-icon')).toBe('pencil');
    edit.click();
    expect(view.state.selection.main.anchor).toBe(view.state.doc.toString().indexOf('\x1b[32m'));
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    expect(view.contentDOM.textContent).toContain('```ansi title:テスト');
    expect(view.contentDOM.textContent).toContain(content);
    const from = view.state.doc.toString().indexOf('XXXXXXXXXXXX');
    view.dispatch({ changes: { from, to: from + 12, insert: 'CHANGED' } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector('.motto-ansi-standalone code')?.textContent).toBe('CHANGED');
    expect(view.contentDOM.textContent).not.toContain('```ansi');
    view.dispatch({ effects: setLivePreview.of(false) });
    expect(view.dom.querySelector('.motto-ansi-view, .motto-header')).toBeNull();
    expect(view.contentDOM.textContent).toContain('```ansi title:テスト');
    expect(view.state.doc.toString()).toBe(`Before\n\n${doc}`.replace('XXXXXXXXXXXX', 'CHANGED'));
  });

  it('keeps ANSI fence metadata editable across cursor movement and preceding edits, then previews after folding', () => {
    const doc = 'Intro\n\n```ansi title:test\nbody\n```\n\nAfter';
    const { view } = fixture(true, doc);
    view.dom.querySelector<HTMLButtonElement>('[aria-label="Edit source"]')!.click();
    view.dispatch({ selection: { anchor: doc.indexOf('```ansi') } });
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    expect(view.contentDOM.textContent).toContain('```ansi title:test');
    view.dispatch({ changes: { from: 0, insert: 'Before\n\n' } });
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    const from = view.state.doc.toString().indexOf('title:test') + 'title:'.length;
    view.dispatch({ changes: { from, to: from + 4, insert: 'renamed' } });
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    expect(view.contentDOM.textContent).toContain('```ansi title:renamed');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.dom.querySelector('.motto-header-title')?.textContent).toBe('renamed');
    expect(view.dom.querySelector('.motto-ansi-standalone code')?.textContent).toBe('body');
    expect(view.contentDOM.textContent).not.toContain('```ansi');
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('title:renamed') } });
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    view.dom.querySelector<HTMLElement>('.motto-header')!.click();
    expect(view.dom.querySelector('.motto-header')?.getAttribute('data-fold-state')).toBe('folded');
    view.dom.querySelector<HTMLElement>('.motto-header')!.click();
    expect(view.dom.querySelector('.motto-ansi-standalone code')?.textContent).toBe('body');
    expect(view.contentDOM.textContent).not.toContain('```ansi');
    expect(view.state.doc.toString()).toBe(`Before\n\n${doc}`.replace('title:test', 'title:renamed'));
  });

  it('updates headerless ANSI previews on cursor movement with commands disabled and restores previews after folding', () => {
    const doc = '```ansi\nfirst\nsecond\n```\n\nAfter';
    const settings: MottoSettings = { ...DEFAULT_SETTINGS, commandBlocks: false, defaultFoldState: 'folded' };
    const { view, updateSettings } = fixture(true, doc, settings);
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(view.dom.querySelector('.motto-ansi-standalone code')?.textContent).toBe('first\nsecond');
    expect(view.contentDOM.textContent).not.toContain('```ansi');
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(2);
    view.dispatch({ selection: { anchor: doc.indexOf('second') } });
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.dom.querySelector('.motto-ansi-standalone')).not.toBeNull();
    updateSettings({ ...settings, headerDisplay: 'always' });
    expect(view.dom.querySelector('.motto-header')?.getAttribute('data-fold-state')).toBe('folded');
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    for (let count = 0; count < 2; count++) {
      view.dom.querySelector<HTMLElement>('.motto-header')!.click();
      expect(view.dom.querySelector('.motto-ansi-standalone code')?.textContent).toBe('first\nsecond');
      view.dom.querySelector<HTMLElement>('.motto-header')!.click();
      expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    }
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('supports standalone ANSI partial previews without overlapping replacements and expands before editing', () => {
    const doc = 'Intro\n\n```ansi title:Log expand:1\nfirst\nsecond\nthird\n```';
    const { view } = fixture(true, doc);
    const preview = view.dom.querySelector<HTMLElement>('.motto-ansi-standalone pre')!;
    expect(preview.style.getPropertyValue('--motto-preview-lines')).toBe('1');
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(1);
    view.dom.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(view.dom.querySelector('.motto-partial-codeblock, .motto-expand-button')).toBeNull();
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(3);
    view.dom.querySelector<HTMLElement>('.motto-header')!.click();
    expect(view.dom.querySelector('.motto-header')?.getAttribute('data-fold-state')).toBe('partial');
    view.dom.querySelector<HTMLButtonElement>('.motto-output-tools button')!.click();
    expect(view.dom.querySelector('.motto-ansi-standalone, .motto-expand-button')).toBeNull();
    expect(view.state.selection.main.anchor).toBe(doc.indexOf('first'));
    expect(view.contentDOM.textContent).toContain('third');
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector('.motto-ansi-standalone code')?.textContent).toBe('first\nsecond\nthird');
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(3);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['fold', 'expand:1'])('reveals standalone ANSI at the closing fence end with %s', (option) => {
    const doc = `Intro\n\n\`\`\`ansi ${option}\nfirst\nsecond\n\`\`\``;
    const { view } = fixture(true, doc);
    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.dom.querySelector('.motto-header')?.getAttribute('data-fold-state')).toBe('expanded');
    expect(view.dom.querySelector('.motto-ansi-standalone, .motto-expand-button')).toBeNull();
    expect(view.contentDOM.textContent).toContain('second');
  });

  it.each(['```ansi\n```', '```ansi'])('keeps empty ANSI editable without modifying its source: %j', (doc) => {
    const { view } = fixture(true, doc);
    expect(view.dom.querySelector('.motto-ansi-standalone code')?.textContent).toBe('');
    expect(view.contentDOM.textContent).not.toContain('```ansi');
    view.dom.querySelector<HTMLButtonElement>('.motto-output-tools button')!.click();
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
    expect(view.contentDOM.textContent).toContain('```ansi');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['sh', 'sh user:root'])('hides native copyable language labels only for commands: %s', (info) => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = `${readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8')}
      .markdown-source-view.mod-cm6 .code-block-flair { display: inline-block; }`;
    document.head.append(stylesheet);
    try {
      const doc = `Intro\n\n\`\`\`${info}\npwd\n\`\`\`\n\`\`\`ansi\n/srv\n\`\`\`\n\n\`\`\`bash title:Ordinary\necho ordinary\n\`\`\``;
      const { view, updateSettings } = fixture(true, doc);
      const sourceView = document.createElement('div');
      sourceView.className = 'markdown-source-view mod-cm6';
      view.dom.before(sourceView);
      sourceView.append(view.dom);
      const flairDisplay = (fence: string) => {
        const line = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')]
          .find((line) => line.textContent === fence)!;
        const flair = document.createElement('span');
        flair.className = 'code-block-flair';
        flair.textContent = 'Shell';
        line.append(flair);
        const display = getComputedStyle(flair).display;
        flair.remove();
        return display;
      };
      expect(flairDisplay(`\`\`\`${info}`)).toBe('none');
      expect(flairDisplay('```bash title:Ordinary')).toBe('inline-block');
      expect(getComputedStyle(view.dom.querySelector('.motto-command-copy')!).display).toBe('inline-flex');
      updateSettings({ ...DEFAULT_SETTINGS, commandBlocks: false });
      expect(flairDisplay(`\`\`\`${info}`)).toBe('inline-block');
      updateSettings(DEFAULT_SETTINGS);
      expect(flairDisplay(`\`\`\`${info}`)).toBe('none');
      view.dispatch({ effects: setLivePreview.of(false) });
      expect(flairDisplay(`\`\`\`${info}`)).toBe('inline-block');
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      stylesheet.remove();
    }
  });

  it('keeps command source editable, copies continuations and preserves output-toggle focus', () => {
    const commands = 'pwd\nprintf \\\n  "hello"';
    const output = '\x1b[32mUNIQUE OUTPUT\x1b[0m';
    const doc = `Intro\n\n\`\`\`sh user:root host:server cwd:/srv/app\n${commands}\n\`\`\`\n\`\`\`ansi\n${output}\n\`\`\``;
    const { view } = fixture(true, doc, { ...DEFAULT_SETTINGS, showHeaderCopyButton: true });
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    expect([...view.dom.querySelectorAll('.motto-command-prompt')].map((node) => node.textContent)).toEqual(['#', '#']);
    expect(view.dom.querySelector('.motto-line-number')).toBeNull();
    expect(view.contentDOM.textContent).toContain('pwd');
    expect(view.contentDOM.textContent).not.toContain('UNIQUE OUTPUT');
    const copies = view.dom.querySelectorAll<HTMLButtonElement>('.motto-command-copy');
    copies[1]!.click();
    expect(write).toHaveBeenLastCalledWith('printf \\\n  "hello"');
    view.dom.querySelector<HTMLButtonElement>('.motto-header-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(commands);
    const toggle = view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    expect(toggle.textContent).toBe('');
    expect(toggle.closest('.motto-command-line')?.getAttribute('style')).toContain('--motto-command-tools-width: 68px');
    toggle.focus();
    toggle.click();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('UNIQUE OUTPUT');
    view.dom.querySelector<HTMLButtonElement>('.motto-output-tools .motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith('UNIQUE OUTPUT');
    const from = doc.indexOf('pwd');
    view.dispatch({ changes: { from, to: from + 3, insert: 'whoami' } });
    view.dom.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith('whoami');
    expect(view.dom.querySelector('.motto-output-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(view.state.doc.toString()).toBe(doc.replace('pwd', 'whoami'));
  });

  it.each(['expand', 'unfold'])('honors ANSI %s, maps its edit control through preceding edits and previews updated output', (option) => {
    const doc = `Intro\n\n\`\`\`sh\npwd\n\`\`\`\n\`\`\`ansi ${option}\n\x1b[32mUNIQUE OUTPUT\x1b[0m\n\`\`\``;
    const { view } = fixture(true, doc);
    expect(view.dom.querySelector('.motto-header, .motto-terminal-icon')).toBeNull();
    expect(view.dom.querySelector('.motto-command-prompt')?.textContent).toBe('$');
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('UNIQUE OUTPUT');
    view.dispatch({ changes: { from: 0, insert: 'Before\n\n' } });
    const edit = view.dom.querySelector<HTMLButtonElement>('.motto-output-tools button[aria-label="Edit source"]')!;
    expect(edit.textContent).toBe('');
    expect(edit.hasAttribute('title')).toBe(false);
    expect(edit.querySelector('svg')?.getAttribute('data-icon')).toBe('pencil');
    edit.click();
    expect(view.state.selection.main.anchor).toBe(view.state.doc.toString().indexOf('\x1b[32m'));
    expect(view.dom.querySelector('.motto-command-output')).toBeNull();
    expect(view.dom.querySelector('.motto-command-output-source')).not.toBeNull();
    const from = view.state.doc.toString().indexOf('UNIQUE OUTPUT');
    view.dispatch({ changes: { from, to: from + 13, insert: 'CHANGED OUTPUT' } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('CHANGED OUTPUT');
    expect(view.state.doc.toString()).toBe(`Before\n\n${doc}`.replace('UNIQUE OUTPUT', 'CHANGED OUTPUT'));
  });

  it.each([4, 5, 6])('previews up to five paired ANSI lines without a header (%s output lines)', (count) => {
    const text = ['first', '', 'third', 'fourth', 'fifth', 'sixth'].slice(0, count).join('\n');
    const doc = `Intro\n\n\`\`\`bash\npwd\n\`\`\`\n\`\`\`ansi expand:5\n\x1b[31m${text}\x1b[0m\n\`\`\``;
    const { view } = fixture(true, doc, { ...DEFAULT_SETTINGS, headerDisplay: 'none' });
    const output = view.dom.querySelector<HTMLElement>('.motto-command-output')!;
    expect(output.querySelector('code')?.textContent).toBe(text);
    expect(output.querySelector('.motto-partial-codeblock') !== null).toBe(count > 5);
    expect(output.querySelector('.motto-expand-button') !== null).toBe(count > 5);
    expect(output.querySelectorAll('.motto-line-number')).toHaveLength(0);
    if (count > 5) {
      expect(output.querySelector('pre')?.style.getPropertyValue('--motto-preview-lines')).toBe('5');
      expect(output.querySelector('.motto-expand-button')?.textContent).toBe('Show all (1 more line)');
      output.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
      expect(view.dom.querySelector('.motto-partial-codeblock')).toBeNull();
      view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(view.dom.querySelector<HTMLElement>('.motto-partial-codeblock')?.style.getPropertyValue('--motto-preview-lines')).toBe('5');
      expect(view.dom.querySelector('.motto-output-toggle')?.getAttribute('aria-expanded')).toBe('true');
    } else {
      view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(view.dom.querySelector('.motto-command-output')).toBeNull();
    }
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['expand', 'unfold'])('returns fully expanded output to its %s preview and resets changed counts', (option) => {
    const text = 'first\nsecond\nthird\nfourth';
    const doc = `Intro\n\n\`\`\`sh\npwd\n\`\`\`\n\`\`\`ansi ${option}:2\n\x1b[32m${text}\x1b[0m\n\`\`\``;
    const { view, updateSettings } = fixture(true, doc);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const toggle = () => view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    const preview = () => view.dom.querySelector<HTMLElement>('.motto-partial-codeblock');
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    view.dom.querySelector<HTMLButtonElement>('.motto-output-tools .motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(text);
    toggle();
    expect(view.dom.querySelector('.motto-command-output')).toBeNull();
    toggle();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    view.dom.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(preview()).toBeNull();
    expect(view.dom.querySelector('.motto-expand-button')).toBeNull();
    updateSettings(parseSettings({ headerDisplay: 'none', outputToggleStyles: { light: { icon: 'hippo' } } }));
    view.dispatch({ changes: { from: 0, insert: 'Before\n\n' } });
    expect(preview()).toBeNull();
    toggle();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    expect(view.dom.querySelector('.motto-output-toggle')?.getAttribute('aria-expanded')).toBe('true');
    toggle();
    expect(view.dom.querySelector('.motto-command-output')).toBeNull();
    toggle();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe(text);
    view.dom.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(preview()).toBeNull();
    const from = view.state.doc.toString().indexOf(`${option}:2`) + option.length + 1;
    view.dispatch({ changes: { from, to: from + 1, insert: '1' } });
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('1');
    expect(view.state.doc.toString()).toBe(`Before\n\n${doc}`.replace(`${option}:2`, `${option}:1`));
  });

  it('reveals all paired partial output before source editing and preserves source mode', () => {
    const doc = 'Intro\n\n```sh\npwd\n```\n```ansi expand:1\nfirst\nsecond\nthird\n```';
    const { view } = fixture(true, doc);
    view.dom.querySelector<HTMLButtonElement>('[aria-label="Edit source"]')!.click();
    expect(view.dom.querySelector('.motto-command-output, .motto-expand-button')).toBeNull();
    expect(view.contentDOM.textContent).toContain('third');
    expect(view.state.selection.main.anchor).toBe(doc.indexOf('first'));
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector('.motto-partial-codeblock, .motto-expand-button')).toBeNull();
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('first\nsecond\nthird');
    view.dispatch({ effects: setLivePreview.of(false) });
    expect(view.dom.querySelector('.motto-command-output, .motto-expand-button, .motto-command-marker')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['body', 'closing fence end'])('reveals folded paired output for a cursor at its %s and leaves source mode unmodified', (position) => {
    const doc = 'Intro\n\n```sh user:root fold\npwd\n```\n```ansi\nUNIQUE OUTPUT\n```';
    const { view } = fixture(true, doc);
    expect(view.contentDOM.textContent).not.toContain('pwd');
    expect(view.contentDOM.textContent).not.toContain('UNIQUE OUTPUT');
    view.dispatch({ selection: { anchor: position === 'body' ? doc.indexOf('UNIQUE OUTPUT') : doc.length } });
    expect(view.dom.querySelector('.motto-header')?.getAttribute('data-fold-state')).toBe('expanded');
    expect(view.dom.querySelector('.motto-command-output-source')).not.toBeNull();
    expect(view.contentDOM.textContent).toContain('pwd');
    expect(view.contentDOM.textContent).toContain('UNIQUE OUTPUT');
    view.dispatch({ effects: setLivePreview.of(false) });
    expect(view.dom.querySelector('.motto-command-marker, .motto-command-output, .motto-header')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('supports empty headerless commands and restores ordinary rendering when disabled', () => {
    const doc = 'Intro\n\n```sh\n```\n```ansi\noutput\n```';
    const { view, updateSettings } = fixture(true, doc);
    expect(view.dom.querySelector('.motto-header, .motto-terminal-icon')).toBeNull();
    expect(view.dom.querySelector('.motto-command-empty-tools')).not.toBeNull();
    view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('output');
    updateSettings({ ...DEFAULT_SETTINGS, commandBlocks: false });
    expect(view.dom.querySelector('.motto-command-empty-tools, .motto-command-output')).toBeNull();
    expect(view.contentDOM.textContent).toContain('output');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('updates visibility with modes and fence parameters without hiding headerless code', () => {
    const doc = 'Intro\n\n```js\nfirst()\nsecond()\n```';
    const settings: MottoSettings = { ...DEFAULT_SETTINGS, defaultFoldState: 'partial', partialFoldLines: 1 };
    const { view, updateSettings } = fixture(true, doc, settings);
    const header = () => view.dom.querySelector<HTMLElement>('.motto-header');
    expect(header()).toBeNull();
    expect(view.dom.querySelector('.motto-expand-button')).toBeNull();
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(2);
    expect(view.contentDOM.textContent).toContain('second()');
    updateSettings({ ...settings, headerDisplay: 'always' });
    expect(header()?.dataset.foldState).toBe('partial');
    expect(view.dom.querySelector('.motto-expand-button')).not.toBeNull();
    updateSettings({ ...settings, headerDisplay: 'none' });
    expect(header()).toBeNull();
    expect(view.dom.querySelector('.motto-expand-button')).toBeNull();
    expect(view.contentDOM.textContent).toContain('second()');
    updateSettings(settings);
    const from = view.state.doc.line(3).to;
    view.dispatch({ changes: { from, insert: ' fold' } });
    expect(header()?.dataset.foldState).toBe('folded');
    expect(view.contentDOM.textContent).not.toContain('first()');
    updateSettings({ ...settings, headerDisplay: 'none' });
    expect(header()).toBeNull();
    expect(view.contentDOM.textContent).toContain('first()');
    updateSettings(settings);
    expect(header()?.dataset.foldState).toBe('folded');
    view.dispatch({ changes: { from, to: from + 5 } });
    expect(header()).toBeNull();
    expect(view.contentDOM.textContent).toContain('second()');
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(2);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['fold', 'expand:1'])('copies the current complete body from a %s header after edits', (option) => {
    const content = 'first()\n\nlast()\n';
    const doc = `Intro\n\n\`\`\`js ${option}\n${content}\n\`\`\``;
    const { view, updateSettings } = fixture(true, doc);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const header = () => view.dom.querySelector<HTMLElement>('.motto-header')!;
    const copy = () => header().querySelector<HTMLButtonElement>('.motto-header-copy')!.click();
    const state = header().dataset.foldState;
    expect(header().querySelector('.motto-header-copy')).toBeNull();
    updateSettings({ ...DEFAULT_SETTINGS, showHeaderCopyButton: true });
    copy();
    expect(write).toHaveBeenLastCalledWith(content);
    expect(header().dataset.foldState).toBe(state);
    expect(view.state.selection.main.anchor).toBe(0);
    const from = view.state.doc.toString().indexOf('last()');
    view.dispatch({ changes: { from, to: from + 6, insert: 'changed()' } });
    copy();
    expect(write).toHaveBeenLastCalledWith(content.replace('last()', 'changed()'));
    view.dispatch({ changes: { from: 0, insert: 'Before\n\n' } });
    copy();
    expect(write).toHaveBeenLastCalledWith(content.replace('last()', 'changed()'));
    expect(header().dataset.foldState).toBe(state);
    header().click();
    updateSettings(DEFAULT_SETTINGS);
    expect(header().querySelector('.motto-header-copy')).toBeNull();
    expect(header().dataset.foldState).toBe('expanded');
  });

  it.each([4, 5, 6])('previews five logical lines only when the body has more than five lines: %i', (count) => {
    const lines = ['a long wrapped source line '.repeat(40), '', 'third()', 'fourth()', 'fifth()', 'last()'];
    const doc = `Intro\n\n\`\`\`js expand:5\n${lines.slice(0, count).join('\n')}\n\`\`\``;
    const { view } = fixture(true, doc);
    expect(view.dom.querySelector('.motto-header')?.getAttribute('data-fold-state'))
      .toBe(count > 5 ? 'partial' : 'expanded');
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(Math.min(5, count));
    expect(view.dom.querySelector('.motto-expand-button') !== null).toBe(count > 5);
    expect(view.dom.querySelector('.motto-expand-footer > .motto-expand-button') !== null).toBe(count > 5);
    expect(view.dom.querySelectorAll('.motto-preview-end')).toHaveLength(count > 5 ? 1 : 0);
    if (count > 5) expect(view.dom.querySelector('.motto-preview-end')?.textContent).toContain('fifth()');
    expect(view.contentDOM.textContent?.includes('last()')).toBe(false);
    expect(view.contentDOM.textContent?.includes('fifth()')).toBe(count >= 5);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('toggles partial/full views from the header and footer and preserves manual expansion through refresh', () => {
    const doc = 'Intro\n\n```js expand:2\nfirst()\nsecond()\nthird()\nlast()\n```';
    const { view, updateSettings } = fixture(true, doc);
    const header = () => view.dom.querySelector<HTMLElement>('.motto-header')!;
    expect(header().dataset.foldState).toBe('partial');
    expect(view.dom.querySelector('.motto-preview-end')?.textContent).toContain('second()');
    expect(view.dom.querySelector('.motto-expand-button')?.textContent).toContain('2 more lines');
    header().click();
    expect(header().dataset.foldState).toBe('expanded');
    expect(view.dom.querySelector('.motto-preview-end')).toBeNull();
    expect(view.contentDOM.textContent).toContain('last()');
    view.dispatch({ changes: { from: 0, insert: 'Before\n\n' } });
    updateSettings({ ...DEFAULT_SETTINGS, defaultFoldState: 'folded', partialFoldLines: 1 });
    expect(header().dataset.foldState).toBe('expanded');
    header().click();
    expect(header().dataset.foldState).toBe('partial');
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(2);
    view.dom.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(header().dataset.foldState).toBe('expanded');
    expect(view.dom.querySelector('.motto-preview-end')).toBeNull();
    expect(view.dom.querySelector('.motto-expand-footer, .motto-expand-button')).toBeNull();
  });

  it('uses the default preview length only for unmarked blocks and updates untouched previews', () => {
    const doc = 'Intro\n\n' + ['expand', 'expand:2', 'title:Default']
      .map((option) => `\`\`\`js ${option}\n${Array.from({ length: 4 }, (_, i) => `line${i + 1}()`).join('\n')}\n\`\`\``)
      .join('\n\n');
    const { view, updateSettings } = fixture(true, doc, {
      ...DEFAULT_SETTINGS, defaultFoldState: 'partial', partialFoldLines: 3,
    });
    const states = () => [...view.dom.querySelectorAll<HTMLElement>('.motto-header')].map((h) => h.dataset.foldState);
    expect(states()).toEqual(['expanded', 'partial', 'partial']);
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(9);
    updateSettings({ ...DEFAULT_SETTINGS, defaultFoldState: 'partial', partialFoldLines: 1 });
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(7);
    expect([...view.dom.querySelectorAll('.motto-expand-button')].map((button) => button.textContent))
      .toEqual(['Show all (2 more lines)', 'Show all (3 more lines)']);
  });

  it('keeps visible lines editable but expands for hidden cursors and whole-body selections', () => {
    const doc = 'Intro\n\n```js expand:2\nfirst()\nsecond()\nthird()\nlast()\n```';
    const { view } = fixture(true, doc);
    const state = () => view.dom.querySelector<HTMLElement>('.motto-header')?.dataset.foldState;
    const from = doc.indexOf('first()') + 1;
    view.dispatch({ selection: { anchor: from }, changes: { from, insert: 'x' } });
    expect(state()).toBe('partial');
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('last()') } });
    expect(state()).toBe('expanded');
    view.dispatch({ selection: { anchor: 0 } });
    const option = view.state.doc.toString().indexOf('expand:2') + 7;
    view.dispatch({ changes: { from: option, to: option + 1, insert: '1' } });
    expect(state()).toBe('partial');
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from + 1 } });
    expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }), 'editor')).toBe(true);
    expect(state()).toBe('expanded');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toContain('last()');
  });

  it('replaces an unfinished trailing blank row with the expand footer and removes previews in source mode', () => {
    const doc = 'Intro\n\n```js expand:2\nfirst()\nsecond()\n';
    const { view } = fixture(true, doc);
    const lines = [...view.contentDOM.querySelectorAll('.cm-line')];
    expect(lines[lines.length - 1]?.querySelector('.motto-line-number')?.textContent).toBe('2');
    expect(view.dom.querySelector('.motto-expand-button')?.textContent).toContain('1 more line');
    view.dispatch({ effects: setLivePreview.of(false) });
    expect(view.dom.querySelector('.motto-expand-button')).toBeNull();
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['expanded', 'folded'] as const)('prioritizes explicit folding options over the %s default', (defaultFoldState) => {
    const doc = 'Intro\n\n' + ['fold', 'expand', 'unfold', 'title:Default']
      .map((option, index) => `\`\`\`js ${option}\nblock${index}()\nsecond()\n\`\`\``).join('\n\n');
    const { view } = fixture(true, doc, { ...DEFAULT_SETTINGS, defaultFoldState });
    expect([...view.dom.querySelectorAll('.motto-header-toggle')].map((toggle) => toggle.getAttribute('aria-expanded')))
      .toEqual(['false', 'true', 'true', String(defaultFoldState === 'expanded')]);
    expect(view.contentDOM.textContent).not.toContain('block0()');
    expect(view.contentDOM.textContent).toContain('block1()');
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(defaultFoldState === 'folded' ? 4 : 6);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('keeps manual overrides through edits and refreshes while initializing newly inserted blocks', () => {
    const doc = 'Intro\n\n```js title:First\nfirst()\n```\n\n```js title:Second\nsecond()\n```';
    const settings: MottoSettings = { ...DEFAULT_SETTINGS, defaultFoldState: 'folded' };
    const { view, updateSettings } = fixture(true, doc, settings);
    const headers = () => [...view.dom.querySelectorAll<HTMLElement>('.motto-header')];
    const expanded = () => headers().map((header) => header.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded'));
    headers()[0]!.click();
    view.dispatch({ changes: { from: 0, insert: 'Before\n\n' } });
    updateSettings({ ...settings, showIcon: false });
    expect(expanded()).toEqual(['true', 'false']);
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n```js title:Third\nthird()\n```' } });
    expect(expanded()).toEqual(['true', 'false', 'false']);
    updateSettings({ ...settings, defaultFoldState: 'expanded' });
    expect(expanded()).toEqual(['true', 'true', 'true']);
    headers()[0]!.click();
    updateSettings(settings);
    updateSettings({ ...settings, defaultFoldState: 'expanded' });
    expect(expanded()).toEqual(['false', 'true', 'true']);
  });

  it('reapplies the initial policy when folding options change but not on unrelated fence edits', () => {
    const { view } = fixture(true, 'Intro\n\n```js fold title:First\nrun()\n```');
    const header = () => view.dom.querySelector<HTMLElement>('.motto-header')!;
    header().click();
    let from = view.state.doc.toString().indexOf('First');
    view.dispatch({ changes: { from, to: from + 5, insert: 'Changed' } });
    expect(header().querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('true');
    from = view.state.doc.toString().indexOf(' fold');
    view.dispatch({ changes: { from, to: from + 5, insert: ' expand' } });
    view.dispatch({ changes: { from, to: from + 7, insert: ' fold' } });
    expect(header().querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('false');
    view.dispatch({ changes: { from, to: from + 5 } });
    expect(header().querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the cursor visible and reveals initially folded code when headers or live preview are disabled', () => {
    const settings: MottoSettings = { ...DEFAULT_SETTINGS, defaultFoldState: 'folded' };
    const { view, updateSettings } = fixture(true, 'Intro\n\n```js fold\nrun()\n```', settings);
    const expanded = () => view.dom.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded');
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('run()') } });
    expect(expanded()).toBe('true');
    updateSettings(settings);
    expect(expanded()).toBe('true');
    view.dispatch({ selection: { anchor: 0 }, effects: setLivePreview.of(false) });
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(view.contentDOM.textContent).toContain('run()');
    view.dispatch({ effects: setLivePreview.of(true) });
    expect(expanded()).toBe('false');
    updateSettings({ ...settings, headerDisplay: 'none' });
    expect(view.contentDOM.textContent).toContain('run()');
    updateSettings({ ...settings, showIcon: false, showLanguage: false });
    expect(view.dom.querySelector('.motto-header-copy')).toBeNull();
    expect(view.dom.querySelector('.motto-header-toggle')).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain('run()');
    updateSettings(settings);
    expect(expanded()).toBe('false');
  });

  it('selects only the current block body, then delegates the next select-all to the editor', () => {
    const doc = 'Intro\n\n```js\nfirst()\n\nlast()\n```\n\n```py\nprint(1)\n```\n\nOutro';
    const { view } = fixture(true, doc);
    view.dispatch({ effects: StateEffect.appendConfig.of(keymap.of([{
      key: 'Mod-a',
      run(view) {
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        return true;
      },
    }])) });
    view.dispatch({ selection: { anchor: doc.indexOf('first()') + 2 } });
    const event = () => new KeyboardEvent('keydown', { key: 'a', ctrlKey: true });
    expect(runScopeHandlers(view, event(), 'editor')).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to))
      .toBe('first()\n\nlast()');
    expect(runScopeHandlers(view, event(), 'editor')).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(doc.length);
    view.dispatch({ selection: { anchor: doc.indexOf('print(1)') + 2 } });
    expect(runScopeHandlers(view, event(), 'editor')).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('print(1)');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each([
    ['```js\nfirst()\nlast()', 'first()\nlast()'],
    ['```js\nfirst()\n\n```', 'first()\n'],
    ['  ```js\n  first()\n  last()\n  ```', '  first()\n  last()'],
  ])('selects unfinished and blank body lines without requiring headers or numbers in %j', (doc, expected) => {
    const { view, updateSettings } = fixture(true, doc);
    updateSettings({ ...DEFAULT_SETTINGS, headerDisplay: 'none', lineNumbers: 'none' });
    const anchor = doc.indexOf('first()') + 1;
    view.dispatch({ selection: { anchor: anchor + 2, head: anchor } });
    expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }), 'editor')).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(expected);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('leaves select-all unchanged outside the body, across blocks, in source mode and with multiple cursors', () => {
    const { view } = fixture();
    const selectAll = () => runScopeHandlers(view,
      new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }), 'editor');
    for (const anchor of [0, source.indexOf('```ts') + 2, source.indexOf('\n```') + 2]) {
      view.dispatch({ selection: { anchor } });
      expect(selectAll()).toBe(false);
    }
    view.dispatch({ selection: { anchor: source.indexOf('const n'), head: source.indexOf('npm install') } });
    expect(selectAll()).toBe(false);
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) });
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(source.indexOf('const n')),
        EditorSelection.cursor(source.indexOf('npm install')),
      ]),
    });
    expect(selectAll()).toBe(false);
    view.dispatch({
      effects: setLivePreview.of(false),
      selection: { anchor: source.indexOf('const n') },
    });
    expect(selectAll()).toBe(false);
  });

  it('numbers body lines and blanks per block, updates edits, and excludes fences', () => {
    const doc = '```js title:First\nfirst()\n\nlast()\n```\n\n```py\nprint(1)\n```';
    const { view, updateSettings } = fixture(true, doc);
    const numbers = () => [...view.dom.querySelectorAll('.motto-line-number')].map((n) => n.textContent);
    expect(numbers()).toEqual(['1', '2', '3']);
    expect([...view.dom.querySelectorAll('.motto-line-number')].every((n) =>
      n.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(view.contentDOM.querySelectorAll('.motto-numbered-line')).toHaveLength(3);
    const from = doc.indexOf('last()');
    view.dispatch({ changes: { from, insert: 'added()\n' } });
    expect(numbers()).toEqual(['1', '2', '3', '4']);
    expect(view.state.doc.sliceString(0)).toBe(doc.slice(0, from) + 'added()\n' + doc.slice(from));
    view.dom.querySelector<HTMLElement>('.motto-header')!.click();
    expect(numbers()).toEqual([]);
    updateSettings({ ...DEFAULT_SETTINGS, lineNumbers: 'always' });
    expect(numbers()).toEqual(['1']);
    expect(view.dom.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('false');
    view.dom.querySelector<HTMLElement>('.motto-header')!.click();
    expect(numbers()).toEqual(['1', '2', '3', '4', '1']);
  });

  it('applies each mode to zero, one and two logical lines', () => {
    const single = 'a long single line '.repeat(40);
    const doc = `\`\`\`js\n\`\`\`\n\n\`\`\`js\n${single}\n\`\`\`\n\n\`\`\`js\ntwo()\n\n\`\`\``;
    const { view, updateSettings } = fixture(true, doc);
    for (const [lineNumbers, expected] of [
      ['default', ['1', '2']],
      ['always', ['1', '1', '2']],
      ['none', []],
    ] as const) {
      updateSettings({ ...DEFAULT_SETTINGS, lineNumbers });
      expect([...view.dom.querySelectorAll('.motto-line-number')].map((n) => n.textContent)).toEqual(expected);
    }
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('shows and removes the default gutter when edits cross the two-line threshold', () => {
    const doc = '```js\nfirst()\n```';
    const { view } = fixture(true, doc);
    expect(view.dom.querySelector('.motto-numbered-line')).toBeNull();
    const from = doc.indexOf('\n```');
    const insert = '\nsecond()';
    view.dispatch({ changes: { from, insert } });
    expect([...view.dom.querySelectorAll('.motto-line-number')].map((n) => n.textContent)).toEqual(['1', '2']);
    view.dispatch({ changes: { from, to: from + insert.length } });
    expect(view.dom.querySelector('.motto-line-number')).toBeNull();
    expect(view.dom.querySelector('.motto-numbered-line')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('toggles numbers independently of headers and removes them in source mode', () => {
    const { view, updateSettings } = fixture();
    updateSettings({ ...DEFAULT_SETTINGS, lineNumbers: 'always', headerDisplay: 'none' });
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(2);
    updateSettings({ ...DEFAULT_SETTINGS, lineNumbers: 'none' });
    expect(view.dom.querySelectorAll('.motto-header')).toHaveLength(2);
    expect(view.dom.querySelector('.motto-line-number')).toBeNull();
    updateSettings({ ...DEFAULT_SETTINGS, lineNumbers: 'always' });
    view.dispatch({ effects: setLivePreview.of(false) });
    expect(view.dom.querySelector('.motto-line-number')).toBeNull();
    view.dispatch({ effects: setLivePreview.of(true) });
    expect(view.dom.querySelectorAll('.motto-line-number')).toHaveLength(2);
    expect(view.state.doc.toString()).toBe(source);
  });

  it('reserves enough gutter space for three-digit numbers and numbers unfinished body lines', () => {
    const doc = `\`\`\`js\n${Array.from({ length: 100 }, (_,n) => `line${n + 1}()`).join('\n')}`;
    const { view } = fixture(true, doc);
    expect(view.contentDOM.querySelector<HTMLElement>('.motto-numbered-line')!
      .style.getPropertyValue('--motto-line-number-width')).toBe('3ch');
    expect(view.dom.querySelector('.motto-line-number')?.textContent).toBe('1');
    const from = doc.indexOf('line2');
    view.dispatch({ selection: { anchor: from } });
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('updates and removes per-block styles while retaining folded code and other metadata', () => {
    const doc = '```ts file:main.ts header-style:warning\nconst n = 1;\n```';
    const { view } = fixture(true, doc);
    const header = () => view.dom.querySelector<HTMLElement>('.motto-header')!;
    const background = () => header().querySelector<HTMLElement>('.motto-header-background');
    expect(background()?.dataset.callout).toBe('warning');
    header().click();
    const from = doc.indexOf('warning');
    view.dispatch({ changes: { from, to: from + 'warning'.length, insert: 'error' } });
    expect(background()?.dataset.callout).toBe('error');
    expect(header().querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(header().querySelector('.motto-header-title')?.textContent).toBe('main.ts');
    expect(view.contentDOM.textContent).not.toContain('const n = 1;');
    const optionStart = view.state.doc.toString().indexOf(' header-style:');
    view.dispatch({ changes: { from: optionStart, to: optionStart + ' header-style:error'.length } });
    expect(background()).toBeNull();
    expect(header().hasAttribute('data-header-style')).toBe(false);
    expect(header().querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('false');
    header().click();
    expect(view.contentDOM.textContent).toContain('const n = 1;');
    expect(view.state.doc.toString()).toBe('```ts file:main.ts\nconst n = 1;\n```');
  });

  it('updates per-mode appearance in place without losing the folded state or source', () => {
    const { view, updateSettings } = fixture();
    const header = view.dom.querySelector<HTMLElement>('.motto-header')!;
    header.click();
    updateSettings({
      ...DEFAULT_SETTINGS,
      headerStyles: {
        light: { ...DEFAULT_SETTINGS.headerStyles.light, titleFontSize: 20, iconSize: 'large' },
        dark: { ...DEFAULT_SETTINGS.headerStyles.dark, background: 'custom', backgroundColor: '#112233' },
      },
    });
    expect(view.dom.querySelector('.motto-header')).toBe(header);
    expect(header.style.getPropertyValue('--motto-light-title-size')).toBe('20px');
    expect(header.style.getPropertyValue('--motto-dark-background')).toBe('#112233');
    expect(header.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(view.contentDOM.textContent).not.toContain('const n = 1;');
    header.click();
    expect(view.contentDOM.textContent).toContain('const n = 1;');
    expect(view.state.doc.toString()).toBe(source);
  });

  it('does not leave empty code lines above or below a folded whole-document block', () => {
    const doc = '```python file:main.py\nprint(1)\n```';
    const { view } = fixture(true, doc);
    const header = view.dom.querySelector<HTMLElement>('.motto-header')!;
    header.click();
    expect(view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(0);
    expect(view.state.doc.toString()).toBe(doc);
    header.click();
    expect(view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(3);
    expect(view.contentDOM.textContent).toContain('print(1)');
  });

  it('folds whole blocks with a stable keyboard-focusable fold control without modifying Markdown', () => {
    const { view } = fixture();
    const header = view.dom.querySelector<HTMLElement>('.motto-header')!;
    const toggle = header.querySelector<HTMLButtonElement>('.motto-header-toggle')!;
    toggle.focus();
    header.querySelector<HTMLElement>('.motto-header-language')!.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.contentDOM.textContent).not.toContain('const n = 1;');
    expect(view.contentDOM.textContent).not.toContain('```ts');
    expect(view.contentDOM.textContent).toContain('npm install');
    expect(view.state.doc.toString()).toBe(source);
    expect(view.dom.querySelector('.motto-header')).toBe(header);
    expect(document.activeElement).toBe(toggle);
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.contentDOM.textContent).toContain('const n = 1;');
    expect(view.state.doc.toString()).toBe(source);
  });

  it('maps folded blocks and header click targets through preceding edits', () => {
    const { view } = fixture();
    const allHeaders = () => [...view.dom.querySelectorAll<HTMLElement>('.motto-header')];
    allHeaders()[0]!.click();
    allHeaders()[1]!.click();
    view.dispatch({ changes: { from: 0, insert: 'New paragraph\n\n' } });
    expect(allHeaders().map((header) => header.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    allHeaders()[1]!.click();
    expect(allHeaders().map((header) => header.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    expect(view.contentDOM.textContent).not.toContain('const n = 1;');
    expect(view.contentDOM.textContent).toContain('npm install');
    const from = view.state.doc.toString().indexOf('```ts');
    const to = view.state.doc.toString().indexOf('```bash');
    view.dispatch({ changes: { from, to } });
    expect(allHeaders()).toHaveLength(1);
    expect(allHeaders()[0]!.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('true');
    allHeaders()[0]!.click();
    expect(view.contentDOM.textContent).not.toContain('npm install');
  });

  it('reveals folded code when the cursor is moved into it', () => {
    const { view } = fixture();
    view.dom.querySelector<HTMLElement>('.motto-header')!.click();
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('const n') } });
    expect(view.dom.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(view.contentDOM.textContent).toContain('const n = 1;');
    expect(view.state.doc.toString()).toBe(source);
  });

  it('reveals folded code when headers are disabled or source mode is entered', () => {
    const { view, updateSettings } = fixture();
    view.dom.querySelector<HTMLElement>('.motto-header')!.click();
    updateSettings({ ...DEFAULT_SETTINGS, showIcon: false });
    expect(view.dom.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('false');
    updateSettings({ ...DEFAULT_SETTINGS, headerDisplay: 'none' });
    expect(view.contentDOM.textContent).toContain('const n = 1;');
    updateSettings({ ...DEFAULT_SETTINGS });
    expect(view.dom.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('true');
    view.dom.querySelector<HTMLElement>('.motto-header')!.click();
    view.dispatch({ effects: setLivePreview.of(false) });
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(view.contentDOM.textContent).toContain('const n = 1;');
    view.dispatch({ effects: setLivePreview.of(true) });
    expect(view.dom.querySelector('.motto-header-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(view.state.doc.toString()).toBe(source);
  });

  it('keeps headers horizontal despite the native block-widget display rule', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8')}
      .markdown-source-view.mod-cm6 .cm-content > * {
        margin: 0 !important;
        display: block;
      }`;
    document.head.append(style);
    try {
      const { view } = fixture();
      const sourceView = document.createElement('div');
      sourceView.className = 'markdown-source-view mod-cm6';
      view.dom.before(sourceView);
      sourceView.append(view.dom);
      const header = view.dom.querySelector<HTMLElement>('.motto-header')!;
      expect(header.parentElement).toBe(view.contentDOM);
      expect(getComputedStyle(header).display).toBe('flex');
      expect(getComputedStyle(view.contentDOM.querySelector('.cm-line')!).display).toBe('block');
    } finally {
      style.remove();
    }
  });

  it('keeps partial output gutters despite the native block-widget display rule', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8')}
      .markdown-source-view.mod-cm6 .cm-content > * {
        margin: 0 !important;
        display: block;
      }`;
    document.head.append(style);
    try {
      const doc = 'Intro\n\n```sh\npwd\n```\n```ansi expand:2\nfirst\nsecond\nthird\n```';
      const { view } = fixture(true, doc);
      const sourceView = document.createElement('div');
      sourceView.className = 'markdown-source-view mod-cm6';
      view.dom.before(sourceView);
      sourceView.append(view.dom);
      const output = () => view.dom.querySelector<HTMLElement>('.motto-command-output')!;
      expect(output().parentElement).toBe(view.contentDOM);
      expect(getComputedStyle(output()).display).toBe('grid');
      output().querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
      expect(output().classList.contains('motto-command-output-partial')).toBe(false);
      view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(getComputedStyle(output()).display).toBe('grid');
      view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(view.dom.querySelector('.motto-command-output')).toBeNull();
      expect(getComputedStyle(view.contentDOM.querySelector('.cm-line')!).display).toBe('block');
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      style.remove();
    }
  });

  it('reserves gutter padding despite the native code-line indentation rule', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8')}
      .markdown-source-view.mod-cm6 .cm-line.HyperMD-codeblock:not(.HyperMD-list-line) {
        padding-inline-start: 16px;
      }`;
    document.head.append(style);
    try {
      const { view } = fixture(true, '```js\nfirst()\nsecond()\n```');
      const sourceView = document.createElement('div');
      sourceView.className = 'markdown-source-view mod-cm6';
      view.dom.before(sourceView);
      sourceView.append(view.dom);
      const line = view.contentDOM.querySelector<HTMLElement>('.motto-numbered-line')!;
      line.classList.add('HyperMD-codeblock');
      expect(getComputedStyle(line).paddingInlineStart).toBe('calc(16px + 2ch + 2.25ch)');
    } finally {
      style.remove();
    }
  });

  it('displays headers at fence starts without replacing code or changing Markdown', () => {
    const { view } = fixture();
    expect([...view.dom.querySelectorAll('.motto-header-title')].map((title) => title.textContent)).toEqual([
      'main.ts', 'Install',
    ]);
    expect(view.state.doc.toString()).toBe(source);
    expect(view.contentDOM.textContent).toContain('const n = 1;');
    expect(view.contentDOM.textContent).toContain('npm install');
  });

  it('updates titles and locations when text before and within a fence changes', () => {
    const { view } = fixture();
    view.dispatch({ changes: { from: 0, insert: 'New paragraph\n\n' } });
    const from = view.state.doc.toString().indexOf('main.ts');
    view.dispatch({ changes: { from, to: from + 'main.ts'.length, insert: 'renamed.ts' } });
    expect(view.dom.querySelector('.motto-header-title')?.textContent).toBe('renamed.ts');
    expect(view.dom.querySelectorAll('.motto-header')).toHaveLength(2);
    expect(view.state.doc.toString()).toContain('file:renamed.ts');
    const end = view.state.doc.toString().indexOf('```bash');
    view.dispatch({ changes: { from: end, to: view.state.doc.length } });
    expect(view.dom.querySelectorAll('.motto-header')).toHaveLength(1);
  });

  it('leaves source mode untouched and responds to native mode switches', () => {
    const { view } = fixture(false);
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    view.dispatch({ effects: setLivePreview.of(true) });
    expect(view.dom.querySelectorAll('.motto-header')).toHaveLength(2);
    view.dispatch({ effects: setLivePreview.of(false) });
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(view.state.doc.toString()).toBe(source);
  });

  it('applies settings immediately to every editor and stops tracking destroyed views', () => {
    const { view, updateSettings, headers } = fixture();
    const second = new EditorView({
      state: EditorState.create({ doc: source, extensions: [editorLivePreviewField, headers.extension] }),
      parent: document.body,
    });
    views.push(second);
    updateSettings({ ...DEFAULT_SETTINGS, showIcon: false });
    expect(view.dom.querySelector('.motto-header-icon')).toBeNull();
    expect(second.dom.querySelector('.motto-header-icon')).toBeNull();
    updateSettings({ ...DEFAULT_SETTINGS, headerDisplay: 'none' });
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(second.dom.querySelector('.motto-header')).toBeNull();
    second.destroy();
    views.splice(views.indexOf(second), 1);
    updateSettings({ ...DEFAULT_SETTINGS });
    expect(view.dom.querySelectorAll('.motto-header')).toHaveLength(2);
  });
});
