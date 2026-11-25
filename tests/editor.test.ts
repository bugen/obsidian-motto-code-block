// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { App, editorInfoField, editorLivePreviewField, type Editor } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ansiIcon from '../src/ansi.svg';
import { createEditorHeaders } from '../src/editor';
import { DEFAULT_SETTINGS, parseSettings, type MottoSettings } from '../src/settings';
import { setLivePreview } from './obsidian';

const views: EditorView[] = [];
const source = 'Intro\n\n```ts file:main.ts\nconst n = 1;\n```\n\n```bash title:Install\nnpm install\n```';

function fixture(livePreview = true, doc = source, initialSettings: MottoSettings = DEFAULT_SETTINGS) {
  let settings = { ...initialSettings };
  const headers = createEditorHeaders(() => settings);
  const mount = (preview = livePreview) => {
    const editor = {} as Editor;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          editorInfoField.init(() => ({ app: new App(), file: null, hoverPopover: null, editor })),
          editorLivePreviewField.init(() => preview), headers.extension,
        ],
      }),
      parent: document.body,
    });
    views.push(view);
    return { view, editor };
  };
  return {
    ...mount(), headers, mount,
    updateSettings(value: typeof settings) { settings = value; headers.refresh(); },
  };
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('live preview headers', () => {
  it('keeps adjacent commands separate while preserving inline prompts and output controls', () => {
    const doc = [
      'Intro', '',
      '```bash cmd prompt:"demo@server:~" prompt-display:inline', 'pwd', '```',
      '```ansi', '/home/demo', '```',
      '```bash cmd prompt:"demo@server:~/work" prompt-display:inline title:Files', 'ls', '```',
      '', '```bash cmd', 'date', '```',
    ].join('\n');
    const { view } = fixture(true, doc);
    const commands = () => [...view.dom.querySelectorAll<HTMLElement>('.motto-command-line')];
    expect([...view.dom.querySelectorAll('.motto-command-prompt')].map((prompt) => prompt.textContent))
      .toEqual(['demo@server:~$', 'demo@server:~/work$', '$']);
    expect(view.dom.querySelectorAll('.motto-command-header')).toHaveLength(1);
    expect(view.dom.querySelector('.motto-command-context')).toBeNull();
    const sourceLines = () => [...view.contentDOM.querySelectorAll('.cm-line')].map((line) => line.textContent);
    const initialLines = sourceLines();
    expect(initialLines.filter((line) => line === '```')).toHaveLength(3);
    expect(initialLines).toContain('```bash cmd prompt:"demo@server:~/work" prompt-display:inline title:Files');
    view.dispatch({ selection: { anchor: doc.indexOf('\nls') + 1 } });
    expect(sourceLines()).toEqual(initialLines);

    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    commands()[1]!.querySelector<HTMLButtonElement>('[aria-label="Copy command"]')!.click();
    expect(write).toHaveBeenLastCalledWith('ls');
    commands()[0]!.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('/home/demo');
    expect(view.dom.querySelector('[data-command-session]')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('lets the user enter a command in an empty second block in the same session', () => {
    const doc = ['```bash cmd', 'ls', '```', '```bash cmd', '```'].join('\n');
    const { view } = fixture(true, doc);
    const sourceLines = () => [...view.contentDOM.querySelectorAll('.cm-line')].map((line) => line.textContent);
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    expect(sourceLines().filter((text) => text === '```bash cmd')).toHaveLength(2);
    expect(sourceLines().filter((text) => text === '```')).toHaveLength(2);

    const closing = view.state.doc.line(5).from;
    view.dispatch({ selection: { anchor: closing } });
    view.dispatch(view.state.replaceSelection('pwd\n'));
    expect(sourceLines().filter((text) => text === '```bash cmd')).toHaveLength(2);
    expect([...view.contentDOM.querySelectorAll('.motto-command-line')].map((line) => line.textContent))
      .toEqual(['$ls', '$pwd']);
    expect(view.state.doc.toString()).toBe(doc.slice(0, closing) + 'pwd\n' + doc.slice(closing));
  });

  it.each([0, 1, 2])('deletes only the selected command fence and its output (session position %s)', (position) => {
    const groups = [
      '```bash cmd\npwd\n```\n```ansi\n/work\n```  ',
      '```bash cmd\nprintf \\\n  hello\necho done\n```\n```plaintext expand\nhello\ndone\n```',
      '```bash cmd\npwd\n```\n```ansi\n/work\n```',
    ];
    const { view } = fixture(true, groups.join('\n'));
    const buttons = [...view.dom.querySelectorAll<HTMLButtonElement>('[aria-label="Delete command block and its output"]')];
    expect(buttons).toHaveLength(3);
    const button = buttons[position]!;
    expect(button.parentElement?.matches('.motto-command-line')).toBe(true);
    expect(button.closest('.motto-command-tools')).toBeNull();
    button.click();
    expect(view.state.doc.toString()).toBe(groups.filter((_, index) => index !== position).join('\n'));
    expect(view.dom.querySelectorAll('[aria-label="Delete command block and its output"]')).toHaveLength(2);
  });

  it('deletes only the output beside its pencil and does not pair an unrelated following fence', () => {
    const command = '```bash cmd\nls\n```';
    const paired = '```ansi expand\nfile\n```';
    const unrelated = '```plaintext\nstandalone\n```';
    const { view } = fixture(true, ['Intro', '', command, paired, unrelated, '', 'Tail'].join('\n'));
    const pencil = view.dom.querySelector<HTMLButtonElement>('.motto-output-tools [aria-label="Edit source"]')!;
    const button = pencil.nextElementSibling;
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.getAttribute('aria-label')).toBe('Delete output only');
    if (!(button instanceof HTMLButtonElement)) throw new Error('Missing output deletion button');
    button.click();
    expect(view.state.doc.toString()).toBe(['Intro', '', command, '', unrelated, '', 'Tail'].join('\n'));
    expect(view.dom.querySelector('.motto-output-toggle, .motto-command-output')).toBeNull();
  });

  it.each([
    ['```bash cmd\n```', '.motto-command-start'],
    ['```bash cmd fold\npwd\n```\n```ansi\n/work\n```', '.motto-command-header'],
  ])('allows removing an empty or folded command block', (doc, anchor) => {
    const { view } = fixture(true, `Intro\n\n${doc}\n\nTail\n`);
    const button = view.dom.querySelector<HTMLButtonElement>(`${anchor} [aria-label="Delete command block and its output"]`)!;
    button.click();
    expect(view.state.doc.toString()).toBe('Intro\n\n\nTail\n');
  });

  it('does not offer deletion for unclosed fences or in source mode', () => {
    const unfinished = fixture(true, '```bash cmd\nls\n```\n```ansi expand\nincomplete');
    expect(unfinished.view.dom.querySelector('.motto-command-output')).not.toBeNull();
    expect(unfinished.view.dom.querySelector('.motto-terminal-delete')).toBeNull();
    const sourceMode = fixture(false, '```bash cmd\nls\n```\n```ansi expand\nfile\n```');
    expect(sourceMode.view.dom.querySelector('.motto-terminal-delete')).toBeNull();
  });

  it('places the command deletion button outside the row only when it fits inside the pane', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    document.head.append(style);
    try {
      const { view } = fixture(true, '```bash cmd\npwd\nls\n```');
      const sourceView = document.createElement('div');
      sourceView.className = 'markdown-source-view mod-cm6';
      view.dom.before(sourceView);
      sourceView.append(view.dom);
      const [first, second] = [...view.contentDOM.querySelectorAll('.motto-command-line')];
      const button = first!.querySelector('button.motto-terminal-delete')!;
      let paneWidth = 540;
      const clientWidth = (element: HTMLElement, width: () => number) => {
        Object.defineProperty(element, 'clientWidth', { configurable: true, get: width });
      };
      clientWidth(view.scrollDOM, () => paneWidth);
      clientWidth(document.documentElement, () => 1000);
      vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockImplementation(() => new DOMRect(100, 50, paneWidth, 300));
      vi.spyOn(first!, 'getBoundingClientRect').mockReturnValue(new DOMRect(140, 80, 460, 28));
      const measure = () => { view.scrollDOM.dispatchEvent(new Event('scroll')); };
      measure();
      await vi.waitFor(() => {
        expect(getComputedStyle(button).insetInlineStart).toBe('100%');
      });
      expect(getComputedStyle(button).position).toBe('absolute');
      expect(getComputedStyle(first!).paddingInlineStart).toBe(getComputedStyle(second!).paddingInlineStart);
      expect(getComputedStyle(first!).paddingInlineEnd).toBe(getComputedStyle(second!).paddingInlineEnd);
      paneWidth = 520;
      measure();
      await vi.waitFor(() => {
        expect(getComputedStyle(button).insetInlineStart).toMatch(/^0(?:px)?$/);
      });
    } finally {
      Reflect.deleteProperty(document.documentElement, 'clientWidth');
      style.remove();
    }
  });

  it('reserves inline prompt space only in inline mode and updates the tooltip when metadata changes', () => {
    const doc = '```powershell cmd cwd:"C:/a/very/long/directory" prompt-display:hide\nGet-Location\n```';
    const { view } = fixture(true, doc);
    const prompt = () => view.dom.querySelector<HTMLButtonElement>('.motto-command-prompt')!;
    const hoverText = () => prompt().querySelector('.motto-command-prompt-symbol')?.getAttribute('aria-label');
    const promptWidth = () => prompt().closest<HTMLElement>('.cm-line')!.style.getPropertyValue('--motto-command-prompt-width');
    expect(prompt().textContent).toBe('>');
    expect(hoverText()).toBe('C:/a/very/long/directory>');
    expect(promptWidth()).toBe('');
    expect(view.dom.querySelector('.motto-header')).toBeNull();

    const changedPath = doc.indexOf('directory');
    view.dispatch({ changes: { from: changedPath, to: changedPath + 'directory'.length, insert: 'elsewhere' } });
    expect(hoverText()).toBe('C:/a/very/long/elsewhere>');
    const mode = view.state.doc.toString().indexOf('hide');
    view.dispatch({ changes: { from: mode, to: mode + 'hide'.length, insert: 'inline' } });
    expect(prompt().querySelector('.motto-command-prompt-context')?.textContent).toBe('C:/a/very/long/elsewhere');
    expect(prompt().lastElementChild?.textContent).toBe('>');
    expect(promptWidth()).toBe('25ch');
  });

  it('still folds blocks and toggles output on older CodeMirror hosts without scrollSnapshot', () => {
    const doc = 'Intro\n\n```js fold\nrun()\n```\n\n```sh\npwd\n```\n```plaintext\n/work\n```';
    const { view } = fixture(true, doc);
    Object.defineProperty(view, 'scrollSnapshot', { value: undefined });
    const header = view.dom.querySelector<HTMLElement>('.motto-header')!;
    const toggle = () => view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();

    header.click();
    expect(header.dataset.foldState).toBe('expanded');
    toggle();
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('/work');
    toggle();
    expect(view.dom.querySelector('.motto-command-output')).toBeNull();
    header.click();
    expect(header.dataset.foldState).toBe('folded');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('changes headed bodies and paired outputs independently in the active Live Preview editor', () => {
    const doc = [
      'Intro', '```js fold\nfolded()\n```', '```js title:Default\none()\ntwo()\n```',
      '```js\nheaderless()\n```', '```js fold exclude\nexcluded()\n```',
      '```sh expand:1\npwd\nls\n```\n```ansi expand:1\n/work\nfile\n```',
      '```sh\nuname\n```\n```plaintext\nLinux\n```',
    ].join('\n\n');
    const { view, editor, headers, mount } = fixture(true, doc, {
      ...DEFAULT_SETTINGS, defaultFoldState: 'partial', partialFoldLines: 1,
    });
    const other = mount();
    const sourceEditor = mount(false);
    const states = (pane = view) => [...pane.dom.querySelectorAll<HTMLElement>('.motto-header')]
      .map((header) => header.dataset.foldState);
    const outputs = () => [...view.dom.querySelectorAll('.motto-command-output code')].map((code) => code.textContent);
    view.dispatch({ selection: { anchor: doc.indexOf('two()') } });
    expect(headers.setNoteFolds(editor, 'fold-blocks', true)).toBe(true);
    expect(states()).toEqual(['folded', 'expanded', 'partial']);
    expect(headers.setNoteFolds(sourceEditor.editor, 'open-outputs', false)).toBe(false);
    expect(states(sourceEditor.view)).toEqual([]);
    headers.setNoteFolds(editor, 'fold-blocks', false);
    expect(states()).toEqual(['folded', 'folded', 'folded']);
    expect(view.state.selection.main.head).toBe(doc.indexOf('```js title:Default'));
    expect(view.dom.textContent).toContain('headerless()');
    expect(view.dom.textContent).toContain('excluded()');
    expect(outputs()).toEqual([]);

    headers.setNoteFolds(editor, 'expand-blocks', false);
    expect(states()).toEqual(['expanded', 'expanded', 'expanded']);
    expect(outputs()).toEqual(['/work\nfile']);
    expect(view.dom.querySelector('.motto-command-output .motto-partial-codeblock')).not.toBeNull();
    headers.setNoteFolds(editor, 'fold-blocks', false);
    headers.setNoteFolds(editor, 'open-outputs', false);
    expect(states()).toEqual(['folded', 'folded', 'expanded']);
    expect(outputs()).toEqual(['/work\nfile', 'Linux']);
    expect(view.dom.querySelector('.motto-command-output .motto-partial-codeblock')).toBeNull();
    const cursor = doc.indexOf('Linux');
    view.dispatch({ selection: { anchor: cursor } });
    headers.setNoteFolds(editor, 'open-outputs', false);
    expect(view.state.selection.main.head).toBe(cursor);
    headers.setNoteFolds(editor, 'close-outputs', false);
    expect(view.state.selection.main.head).toBe(doc.indexOf('```sh\nuname'));
    expect(states()).toEqual(['folded', 'folded', 'expanded']);
    expect(outputs()).toEqual([]);

    headers.setNoteFolds(editor, 'reset-folds', false);
    expect(states()).toEqual(['folded', 'partial', 'partial']);
    expect(outputs()).toEqual([]);
    headers.setNoteFolds(editor, 'expand-blocks', false);
    expect(outputs()).toEqual(['/work\nfile']);
    expect(view.dom.querySelector('.motto-command-output .motto-partial-codeblock')).not.toBeNull();
    expect(states(other.view)).toEqual(['folded', 'partial', 'partial']);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('restores a partial output default even when the editor selection is inside that output', () => {
    const doc = 'Intro\n\n```sh\npwd\n```\n```ansi expand:1\nfirst\nsecond\n```';
    const { view, editor, headers } = fixture(true, doc);
    view.dispatch({ selection: { anchor: doc.indexOf('second') } });
    expect(view.dom.querySelector('.motto-command-output-source')).not.toBeNull();
    headers.setNoteFolds(editor, 'reset-folds', false);
    expect(view.dom.querySelector('.motto-command-output-source')).toBeNull();
    expect(view.dom.querySelector('.motto-command-output .motto-partial-codeblock')).not.toBeNull();
    expect(view.state.selection.main.head).toBe(doc.indexOf('```sh'));
  });

  it('updates configured command languages without requiring them in the general include list', () => {
    const doc = 'Intro\n\n```dash\npwd\n```\n```ansi expand\n/work\n```';
    const { view, updateSettings } = fixture(true, doc);
    const prompt = () => view.dom.querySelector('.motto-command-prompt');
    const output = () => view.dom.querySelector('.motto-command-output');
    expect(prompt()).toBeNull();
    const settings = parseSettings({ commandLanguages: ['dash'], languageIncludeList: ['ansi'] });
    updateSettings(settings);
    expect(prompt()?.textContent).toBe('$');
    expect(output()?.querySelector('code')?.textContent).toBe('/work');
    updateSettings({ ...settings, languageExcludeList: ['dash'] });
    expect(prompt()).toBeNull();
    expect(output()).toBeNull();
    updateSettings(settings);
    expect(output()).not.toBeNull();
    updateSettings({ ...settings, commandLanguages: [] });
    expect(prompt()).toBeNull();
    expect(output()).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('only uses a configured ANSI fence as a command when it meets the activation conditions', () => {
    const doc = 'Intro\n\n```ansi cmd title:Command\nrun\n```\n\n```ansi\noutput\n```';
    const settings = parseSettings({ commandLanguages: ['ansi'] });
    const { view } = fixture(true, doc, settings);
    expect(view.dom.querySelector('.motto-command-prompt')?.textContent).toBe('$');
    expect(view.dom.querySelector('.motto-command-header .motto-language-icon')?.getAttribute('src')).toBe(ansiIcon);
    expect([...view.dom.querySelectorAll('.motto-ansi-standalone code')].map((code) => code.textContent))
      .toEqual(['output']);
  });

  it.each([
    ['text', 'line one\n\nline three\nline four'],
    ['json', '{\n  "ok": true,\n  "count": 2\n}'],
    ['xml', '<result>\n  <value>2</value>\n  <empty />\n</result>'],
  ])('previews, copies and edits configured %s output without changing other source', async (language, text) => {
    const doc = `Intro\n\n\`\`\`sh title:Command\ncat result\n\`\`\`\n\`\`\`${language} expand:2\n${text}\n\`\`\``;
    const { view, updateSettings } = fixture(true, doc);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    expect(view.dom.querySelector('.motto-output-toggle')).toBeNull();
    const settings = parseSettings({ outputLanguages: ['ansi', language] });
    updateSettings(settings);
    const output = () => view.dom.querySelector<HTMLElement>('.motto-command-output')!;
    expect(output().querySelector('code')?.classList.contains(`language-${language}`)).toBe(true);
    expect(output().querySelector('code')?.textContent).toBe(text);
    expect(output().querySelector('.motto-partial-codeblock')).not.toBeNull();
    output().querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(text);
    output().querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(output().querySelector('.motto-partial-codeblock')).toBeNull();
    view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    expect(output()).toBeNull();
    view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    output().querySelector<HTMLButtonElement>('[aria-label="Edit source"]')!.click();
    expect(view.dom.querySelector('.motto-command-output-source')).not.toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
    view.dispatch({ changes: { from: doc.indexOf(text), insert: 'X' } });
    view.dispatch({ selection: { anchor: 0 } });
    await vi.waitFor(() => { expect(output().querySelector('code')?.textContent).toBe(`X${text}`); });
    updateSettings(DEFAULT_SETTINGS);
    expect(view.dom.querySelector('.motto-output-toggle, .motto-command-output')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc.replace(text, `X${text}`));
    updateSettings(settings);
    expect(output().querySelector('.motto-partial-codeblock')).not.toBeNull();
    expect(output().querySelector('code')?.textContent).toBe(`X${text}`);
  });

  it('replaces cached output when only its language changes', () => {
    const doc = 'Intro\n\n```sh\nrun\n```\n```json expand\n{"ok":true}\n```';
    const { view } = fixture(true, doc, parseSettings({ outputLanguages: ['json', 'xml'] }));
    expect(view.dom.querySelector('.motto-command-output code')?.className).toBe('language-json');
    const from = doc.indexOf('json');
    view.dispatch({ changes: { from, to: from + 4, insert: 'xml' } });
    expect(view.dom.querySelector('.motto-command-output code')?.className).toBe('language-xml');
    expect(view.state.doc.toString()).toBe(doc.replace('```json', '```xml'));
  });

  it.each([
    ['sh', 'pwd', 'printf \\\n  "hello"', '#'],
    ['powershell', 'Get-Location', 'Get-ChildItem `\n  -Force', '>'],
  ])('toggles wrapping for a %s command and its continuation without editing or toggling output', (language, first, command, symbol) => {
    const doc = `Intro\n\n\`\`\`${language} user:root\n${first}\n${command}\n\`\`\`\n\`\`\`ansi\n/srv\n\`\`\``;
    const { view, headers } = fixture(true, doc);
    const prompts = () => [...view.dom.querySelectorAll<HTMLButtonElement>('.motto-command-prompt')];
    const lines = () => [...view.dom.querySelectorAll('.motto-command-line')];
    const wrapped = () => lines().map((line) => line.classList.contains('motto-command-wrap'));
    const output = view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    const start = view.state.selection;
    expect(prompts().map((prompt) => prompt.textContent)).toEqual([symbol, symbol]);
    expect(prompts()[1]?.getAttribute('aria-label')).toBe('Toggle command wrapping');
    expect(prompts()[1]?.hasAttribute('title')).toBe(false);
    expect(wrapped()).toEqual([false, false, false]);
    prompts()[1]!.click();
    expect(wrapped()).toEqual([false, true, true]);
    expect(output.getAttribute('aria-expanded')).toBe('false');
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    lines()[1]!.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(command);
    expect(view.state.selection.eq(start)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    view.dispatch({ changes: { from: 0, insert: 'Preface\n' } });
    headers.refresh();
    expect(wrapped()).toEqual([false, true, true]);
    prompts()[1]!.click();
    expect(wrapped()).toEqual([false, false, false]);
    expect(lines()[1]?.classList.contains('motto-command-nowrap')).toBe(true);
  });

  it('spaces only visible command boundaries and preserves continuations, copies and output focus on refresh', () => {
    const commands = 'printf \\\n  "hello"\npwd\nwhoami';
    const doc = `Intro\n\n\`\`\`bash cmd\n${commands}\n\`\`\`\n\`\`\`ansi\n/srv\n\`\`\``;
    const { view, updateSettings } = fixture(true, doc);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    expect(view.dom.querySelectorAll('.motto-command-gap')).toHaveLength(2);
    const toggle = view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    toggle.click();
    toggle.focus();
    for (const commandSpacing of ['small', 'middle', 'large'] as const) {
      updateSettings({ ...DEFAULT_SETTINGS, commandSpacing });
      const gaps = view.dom.querySelectorAll('.motto-command-gap');
      expect(gaps).toHaveLength(commandSpacing === 'small' ? 0 : 2);
      if (commandSpacing !== 'small') {
        expect(gaps[0]?.textContent).toContain('  "hello"');
        expect(gaps[1]?.textContent).toContain('pwd');
        for (const gap of gaps) expect(gap.classList.contains(`motto-command-spacing-${commandSpacing}`)).toBe(true);
      }
      view.dom.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
      expect(write).toHaveBeenLastCalledWith('printf \\\n  "hello"');
      expect(view.dom.querySelector('.motto-output-toggle')).toBe(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(toggle);
      expect(view.state.doc.toString()).toBe(doc);
    }
    const from = doc.indexOf('cmd') + 'cmd'.length;
    view.dispatch({ changes: { from, insert: ' expand:2' } });
    expect(view.dom.querySelector('.motto-command-gap')).toBeNull();
    expect(view.dom.querySelector('.motto-expand-button')).not.toBeNull();
  });

  it('updates headers only when supported parameters are added or removed', () => {
    const doc = 'Intro\n\n```js arbitrary custom:"title:Ignored user:root fold" title user host\nrun()\n```';
    const { view } = fixture(true, doc);
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    const from = doc.indexOf('\nrun()');
    const parameter = ' title:Shown';
    view.dispatch({ changes: { from, insert: parameter } });
    expect(view.dom.querySelector('.motto-header-title')?.textContent).toBe('Shown');
    view.dispatch({ changes: { from, to: from + parameter.length } });
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['cmd', 'command'])('renders explicit %s commands without metadata or paired output', (flag) => {
    const doc = `Intro\n\n\`\`\`bash ${flag}\npwd\n\`\`\``;
    const { view, updateSettings } = fixture(true, doc);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    expect(view.dom.querySelector('.motto-command-prompt')?.textContent).toBe('$');
    expect(view.dom.querySelector('.motto-command-context, .motto-output-toggle')).toBeNull();
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    updateSettings({ ...DEFAULT_SETTINGS, headerDisplay: 'always' });
    expect(view.dom.querySelector('.motto-header')).not.toBeNull();
    updateSettings(DEFAULT_SETTINGS);
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    view.dom.querySelector<HTMLButtonElement>('.motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith('pwd');
    updateSettings({ ...DEFAULT_SETTINGS, commandBlocks: false });
    expect(view.dom.querySelector('.motto-command-marker, .motto-command-prompt')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['js', 'ansi', 'bash', 'my-language', ''])(
    'honors exclude on %j blocks across edits, refresh and selection changes', (language) => {
      const settings = parseSettings({ languageIncludeList: [language || 'plaintext'] });
      const doc = `Intro\n\n\`\`\`${language} title:Test cmd expand:1 exclude\nfirst\nsecond\n\`\`\``;
      const { view, headers } = fixture(true, doc, settings);
      expect(view.dom.querySelector('[class*="motto-"]')).toBeNull();
      const from = doc.indexOf(' exclude');
      view.dispatch({ changes: { from, to: from + ' exclude'.length } });
      expect(view.dom.querySelector('.motto-header')).not.toBeNull();
      expect(view.dom.querySelector('.motto-expand-button')).not.toBeNull();
      view.dispatch({ changes: { from, insert: ' exclude' } });
      headers.refresh();
      expect(view.dom.querySelector('[class*="motto-"]')).toBeNull();
      expect(view.contentDOM.textContent).toContain('second');
      view.dispatch({ selection: { anchor: doc.indexOf('first') } });
      expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }), 'editor')).toBe(false);
      expect(view.state.selection.main.empty).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    },
  );

  it.each(['sh', 'ansi'])('breaks and restores output pairing when %s gains or loses exclude', (excluded) => {
    const doc = 'Intro\n\n```sh cmd\npwd\n```\n```ansi\n/srv\n```';
    const { view } = fixture(true, doc);
    view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('/srv');
    const from = doc.indexOf(`\`\`\`${excluded}`) + `\`\`\`${excluded}`.length;
    view.dispatch({ changes: { from, insert: ' exclude' } });
    expect(view.dom.querySelector('.motto-output-toggle, .motto-command-output')).toBeNull();
    if (excluded === 'sh') {
      expect(view.dom.querySelector('.motto-command-prompt')).toBeNull();
      expect(view.dom.querySelector('.motto-ansi-standalone code')?.textContent).toBe('/srv');
      expect(view.contentDOM.textContent).toContain('```sh exclude cmd');
    } else {
      expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
      expect(view.dom.querySelector('.motto-command-prompt')?.textContent).toBe('$');
      expect(view.contentDOM.textContent).toContain('```ansi exclude');
    }
    view.dispatch({ changes: { from, to: from + ' exclude'.length } });
    view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('/srv');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['pwd', ''])('keeps Hippo replies for command %j across widget updates and removes them in source mode', async (command) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const settings = parseSettings({
      tapMyHippo: true, outputToggleStyles: { light: { icon: 'hippo' } },
    });
    const doc = `Intro\n\n\`\`\`sh\n${command}\n\`\`\`\n\`\`\`ansi\n/srv\n\`\`\``;
    const { view, updateSettings } = fixture(true, doc, settings);
    const button = view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(300, 200, 32, 24));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(document.querySelector('.motto-hippo-speech')?.textContent).toBe('Tap my hip-po!');
    button.click();
    expect(view.dom.querySelector('.motto-output-toggle')).toBe(button);
    expect(document.querySelector('.motto-hippo-speech')?.textContent).toBe('You rang?');
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('/srv');
    updateSettings({ ...settings, tapMyHippo: false });
    expect(document.querySelector('.motto-hippo-speech')).toBeNull();
    updateSettings(settings);
    button.click();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(document.querySelector('.motto-hippo-speech')).not.toBeNull();
    view.dispatch({ effects: setLivePreview.of(false) });
    expect(document.querySelector('.motto-hippo-speech')).toBeNull();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(document.querySelector('.motto-hippo-speech')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['js', 'ansi', 'bash', 'my-language', ''])(
    'leaves excluded %j source and selection behavior alone and refreshes eligibility', (language) => {
      const name = language || 'plaintext';
      const doc = `Intro\n\n\`\`\`${language} title:Test expand:1\nfirst\nsecond\n\`\`\`\n\nAfter`;
      const settings = parseSettings({ languageIncludeList: [] });
      const { view, updateSettings } = fixture(true, doc, settings);
      expect(view.dom.querySelector('[class*="motto-"]')).toBeNull();
      updateSettings({ ...settings, languageIncludeList: [name] });
      expect(view.dom.querySelector('.motto-header')).not.toBeNull();
      expect(view.dom.querySelector('.motto-expand-button')).not.toBeNull();
      updateSettings({ ...settings, languageIncludeList: [name], languageExcludeList: [name] });
      expect(view.dom.querySelector('[class*="motto-"]')).toBeNull();
      expect(view.contentDOM.textContent).toContain('second');
      const from = doc.indexOf('first');
      view.dispatch({ selection: { anchor: from } });
      expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }), 'editor')).toBe(false);
      expect(view.state.selection.main.empty).toBe(true);
      view.dispatch({ selection: { anchor: 0 } });
      updateSettings({ ...settings, languageIncludeList: [name] });
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
    const settings = parseSettings({ languageExcludeList: [excluded] });
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
    expect(toggle.querySelector('.motto-output-icon-dark .motto-output-hippo-flipped')).not.toBeNull();
    expect(toggle.style.getPropertyValue('--motto-output-dark-color')).toBe('#abcdef');
    expect(toggle.parentElement?.classList.contains('motto-output-wide-dark')).toBe(true);
    if (command) {
      expect(toggle.closest('.motto-command-line')?.classList.contains('motto-output-wide-dark')).toBe(true);
    }
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe('/srv');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.querySelector('.motto-output-hippo-flipped')).toBeNull();
    updateSettings(DEFAULT_SETTINGS);
    expect(toggle.style.getPropertyValue('--motto-output-dark-color')).toBe('');
    expect(toggle.parentElement?.classList.contains('motto-output-wide-dark')).toBe(false);
    if (command) {
      expect(toggle.closest('.motto-command-line')?.classList.contains('motto-output-wide-dark')).toBe(false);
    }
    expect(toggle.querySelector('.motto-output-icon-light svg')?.getAttribute('data-icon')).toBe('eye');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('previews titled standalone ANSI and edits its source after preceding changes without altering source mode', () => {
    const content = '\x1b[32mXXXXXXXXXXXX\x1b[0m';
    const doc = `Intro\n\n\`\`\`ansi title:テスト\n${content}\n\`\`\``;
    const { view } = fixture(true, doc, { ...DEFAULT_SETTINGS, showHeaderCopyButton: true });
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    expect(view.dom.querySelector('.motto-header-title')?.textContent).toBe('テスト');
    expect(view.dom.querySelector('.motto-header .motto-language-icon')?.getAttribute('src')).toBe(ansiIcon);
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
    expect(view.dom.querySelector('.motto-ansi-standalone')).toBeNull();
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

  it.each([
    ['user:root host:server cwd:/srv/app', 'root@server:/srv/app'],
    ['prompt:"root@server:/srv/app"', 'root@server:/srv/app'],
    ['prompt:"root"', 'root'],
    ['prompt:"root@server"', 'root@server'],
  ])('keeps commands editable and preserves copies and toggle focus with %s', (metadata, contextText) => {
    const commands = 'pwd\nprintf \\\n  "hello"';
    const output = '\x1b[32mUNIQUE OUTPUT\x1b[0m';
    const doc = `Intro\n\n\`\`\`sh ${metadata}\n${commands}\n\`\`\`\n\`\`\`ansi\n${output}\n\`\`\``;
    const { view } = fixture(true, doc, { ...DEFAULT_SETTINGS, showHeaderCopyButton: true });
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    expect(view.dom.querySelector('.motto-command-context')?.textContent).toBe(contextText);
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
    view.dom.querySelector<HTMLButtonElement>('.motto-command-output .motto-raw-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(output);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
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
      expect(view.dom.querySelector('.motto-command-output')).toBeNull();
      view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(view.dom.querySelector<HTMLElement>('.motto-partial-codeblock')?.style.getPropertyValue('--motto-preview-lines')).toBe('5');
      expect(view.dom.querySelector('.motto-output-toggle')?.getAttribute('aria-expanded')).toBe('true');
    } else {
      view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(view.dom.querySelector('.motto-command-output')).toBeNull();
      view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe(text);
      expect(view.dom.querySelector('.motto-partial-codeblock')).toBeNull();
    }
    expect(view.dom.querySelector('.motto-header')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each(['expand', 'unfold'])('cycles %s output through all three states and resets changed counts', (option) => {
    const text = 'first\nsecond\nthird\nfourth';
    const doc = `Intro\n\n\`\`\`sh\npwd\n\`\`\`\n\`\`\`ansi ${option}:2\n\x1b[32m${text}\x1b[0m\n\`\`\``;
    const { view, updateSettings } = fixture(true, doc);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const button = () => view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
    const toggle = () => button().click();
    const preview = () => view.dom.querySelector<HTMLElement>('.motto-partial-codeblock');
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    expect(button().getAttribute('aria-label')).toBe('Show full output');
    view.dom.querySelector<HTMLButtonElement>('.motto-output-tools .motto-command-copy')!.click();
    expect(write).toHaveBeenLastCalledWith(text);
    toggle();
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe(text);
    expect(preview()).toBeNull();
    expect(button().getAttribute('aria-label')).toBe('Hide output');
    toggle();
    expect(view.dom.querySelector('.motto-command-output')).toBeNull();
    expect(button().getAttribute('aria-expanded')).toBe('false');
    toggle();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    toggle();
    updateSettings(parseSettings({ headerDisplay: 'none', outputToggleStyles: { light: { icon: 'hippo' } } }));
    view.dispatch({ changes: { from: 0, insert: 'Before\n\n' } });
    expect(preview()).toBeNull();
    toggle();
    expect(view.dom.querySelector('.motto-command-output')).toBeNull();
    toggle();
    expect(preview()?.style.getPropertyValue('--motto-preview-lines')).toBe('2');
    expect(view.dom.querySelector('.motto-command-output code')?.textContent).toBe(text);
    view.dom.querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
    expect(preview()).toBeNull();
    expect(button().getAttribute('aria-label')).toBe('Hide output');
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

  it('cycles partial, full and hidden code from the header and preserves manual expansion through refresh', () => {
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
    expect(header().dataset.foldState).toBe('folded');
    expect(view.contentDOM.textContent).not.toContain('first()');
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
    const defaultHeader = [...view.dom.querySelectorAll<HTMLElement>('.motto-header')][2]!;
    for (const state of ['expanded', 'folded', 'partial', 'expanded']) {
      defaultHeader.click();
      expect(defaultHeader.dataset.foldState).toBe(state);
    }
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
      const toggle = () => view.dom.querySelector<HTMLButtonElement>('.motto-output-toggle')!.click();
      expect(output().parentElement).toBe(view.contentDOM);
      expect(getComputedStyle(output()).display).toBe('grid');
      output().querySelector<HTMLButtonElement>('.motto-expand-button')!.click();
      expect(output().classList.contains('motto-command-output-partial')).toBe(false);
      toggle();
      expect(view.dom.querySelector('.motto-command-output')).toBeNull();
      toggle();
      expect(output().classList.contains('motto-command-output-partial')).toBe(true);
      expect(getComputedStyle(output()).display).toBe('grid');
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
