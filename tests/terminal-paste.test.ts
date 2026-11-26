// @vitest-environment happy-dom
import { App, TFile, type Command, type Editor, type EditorPosition, type MarkdownFileInfo } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import MottoCodeBlockPlugin from '../src/main';
import { parseSettings } from '../src/settings';
import type { TranscriptShellMode } from '../src/terminal-prompt';
import { MarkdownView, Notice } from './obsidian';

afterEach(() => {
  Notice.messages.length = 0;
  vi.restoreAllMocks();
});

async function fixture(settings: Record<string, unknown> = {}) {
  let pos: EditorPosition = { line: 1, ch: 0 };
  const notebook = ['before', '', 'after'];
  const editor = Object.assign({} as Editor, {
    getCursor: () => pos,
    getSelection: () => '',
    replaceSelection: vi.fn(),
    getLine: (line: number) => notebook[line]!,
    lastLine: () => notebook.length - 1,
  });
  const file = Object.assign(new TFile(), { path: 'note.md' });
  const getMode = vi.fn<() => 'source' | 'preview'>(() => 'source');
  const app = new App();
  const view = Object.assign(new MarkdownView(), {
    editor, file, getMode, containerEl: document.body, app, hoverPopover: null,
  });
  Object.assign(app, {
    workspace: { on: vi.fn(), getActiveViewOfType: () => view },
  });
  const commands: Command[] = [];
  const plugin = Object.assign(new MottoCodeBlockPlugin(app, {
    id: 'motto-code-block', name: 'Motto Code Block', version: '0.1.1',
    minAppVersion: '1.5.0', author: '', description: '',
  }), {
    app, loadData: async () => ({ terminalPromptPatterns: '^custom!\\$', ...settings }), register: vi.fn(),
    registerMarkdownPostProcessor: vi.fn(), registerEvent: vi.fn(), registerEditorExtension: vi.fn(),
    addSettingTab: vi.fn(), addCommand: (command: Command) => commands.push(command),
  });
  await plugin.onload();
  return {
    editor, getMode,
    trigger(keepAnsi: boolean, checking = false, shell: TranscriptShellMode = 'auto') {
      const label = { auto: '', bash: 'Bash ', powershell: 'PowerShell ' }[shell];
      const name = `Paste ${label}terminal output (${keepAnsi ? 'keep' : 'strip'} ANSI)`;
      const context: MarkdownFileInfo = view;
      return commands.find((command) => command.name === name)!.editorCheckCallback!(checking, editor, context);
    },
    move() { pos = { line: 2, ch: 0 }; },
  };
}

it.each([true, false])('registers editor-only paste and inserts one adjacent Markdown session (keep=%s)', async (keep) => {
  const { editor, trigger, getMode } = await fixture();
  const read = vi.spyOn(navigator.clipboard, 'readText')
    .mockResolvedValue('custom!$ pwd\n\x1b[32m\tC:\\work\x1b[0m\ncustom!$ ls');
  getMode.mockReturnValue('preview');
  expect(trigger(keep, true)).toBe(false);
  getMode.mockReturnValue('source');
  expect(trigger(keep, true)).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(trigger(keep)).toBe(true);
  await vi.waitFor(() => {
    const output = keep ? '```ansi\n\\x1B[32m\\x09C:\\\\work\\x1B[0m\n```' : '```plaintext\n\tC:\\work\n```';
    const info = '```bash cmd prompt-text:"custom!$" prompt-display:hide';
    expect(editor.replaceSelection).toHaveBeenCalledExactlyOnceWith(
      `\n${info}\npwd\n\`\`\`\n${output}\n${info}\nls\n\`\`\`\n\n`,
    );
  });
});

it.each([
  ['bash', true], ['bash', false], ['powershell', true], ['powershell', false],
] as const)('inserts %s fences in explicit shell mode (keep ANSI=%s)', async (shell, keep) => {
  const { editor, trigger } = await fixture();
  const prompt = shell === 'bash' ? '<SITE> demo@host:~/work$' : 'PS C:\\work>';
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue(`${prompt} pwd\n\x1b[32mresult\x1b[0m\n${prompt} ls`);
  expect(trigger(keep, false, shell)).toBe(true);
  await vi.waitFor(() => {
    expect(editor.replaceSelection).toHaveBeenCalledOnce();
    const markdown = editor.replaceSelection.mock.calls[0]?.[0];
    expect(markdown).toContain(`\`\`\`${shell} cmd`);
    expect(markdown).toContain(keep ? '```ansi\n\\x1B[32mresult\\x1B[0m\n```' : '```plaintext\nresult\n```');
    expect(markdown).toContain('\nls\n```');
  });
});

it.each([true, false])('keeps styling that starts after the command echo (keep ANSI=%s)', async (keep) => {
  const { editor, trigger } = await fixture();
  const prompt = '\x1b[1m\x1b[32mdemo@node\x1b[22m\x1b[39m:\x1b[1m\x1b[34m~/work\x1b[22m\x1b[39m$';
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue([
    `${prompt} ^C\x1b[1m\x1b[32m`,
    `${prompt} ls\x1b[1m\x1b[34m`,
    'ascii\x1b[22m\x1b[39m    \x1b[1m\x1b[34msrc',
    'lib\x1b[22m\x1b[39m',
    `${prompt} cd\x1b[0m`,
  ].join('\n'));
  expect(trigger(keep)).toBe(true);
  await vi.waitFor(() => {
    const markdown = editor.replaceSelection.mock.calls[0]?.[0];
    expect(markdown).toBe(
      '\n```bash cmd prompt:"demo@node:~/work" prompt-display:hide\nls\n```\n' +
      (keep ? '```ansi\n\\x1B[1m\\x1B[34mascii\\x1B[22m\\x1B[39m    \\x1B[1m\\x1B[34msrc\nlib\\x1B[22m\\x1B[39m\n```\n'
        : '```plaintext\nascii    src\nlib\n```\n') +
      '```bash cmd prompt:"demo@node:~/work" prompt-display:hide\ncd\n```\n\n',
    );
  });
});

it('notifies without editing on missing prompts, clipboard errors or cursor changes', async () => {
  const { editor, trigger, move } = await fixture();
  const read = vi.spyOn(navigator.clipboard, 'readText').mockResolvedValueOnce('plain output')
    .mockRejectedValueOnce(new Error('permission denied')).mockResolvedValueOnce('$ pwd');
  trigger(true);
  await vi.waitFor(() => { expect(Notice.messages[0]).toContain('first line must start'); });
  trigger(true);
  await vi.waitFor(() => { expect(Notice.messages[1]).toContain('Could not read the clipboard'); });
  trigger(true);
  move();
  await vi.waitFor(() => { expect(Notice.messages[2]).toContain('paste location changed'); });
  expect(read).toHaveBeenCalledTimes(3);
  expect(editor.replaceSelection).not.toHaveBeenCalled();
});

it.each([
  [undefined, ['pwd', 'ls [skip]']],
  ['^C\n[skip]', ['pwd']],
  ['', ['cd ^C', 'pwd', 'ls [skip]']],
] as const)('uses the saved suffix list when pasting (%s)', async (setting, commands) => {
  const { editor, trigger } = await fixture(setting === undefined ? {} : { terminalIgnoredCommandSuffixes: setting });
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('$ cd ^C\n$ pwd\n$ ls [skip]');
  trigger(false);
  await vi.waitFor(() => {
    expect(editor.replaceSelection).toHaveBeenCalledExactlyOnceWith(
      `\n${commands.map((command) => `\`\`\`bash cmd\n${command}\n\`\`\``).join('\n')}\n\n`,
    );
  });
});

it.each([true, false])('uses only enabled prompt patterns when pasting (host%% enabled=%s)', async (enabled) => {
  const { terminalPromptPatterns } = parseSettings({ terminalPromptPatterns: '(' });
  terminalPromptPatterns[0]!.enabled = false;
  terminalPromptPatterns.find(({ id }) => id === 'zsh-host')!.enabled = enabled;
  const { editor, trigger } = await fixture({ terminalPromptPatterns });
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('$ pwd\n100% finished\nhost% ls');
  trigger(false);
  await vi.waitFor(() => {
    const output = `100% finished${enabled ? '' : '\nhost% ls'}`;
    const next = enabled ? '\n```zsh cmd prompt-text:"host%" prompt-display:hide\nls\n```' : '';
    expect(editor.replaceSelection).toHaveBeenCalledExactlyOnceWith(
      `\n\`\`\`bash cmd\npwd\n\`\`\`\n\`\`\`plaintext\n${output}\n\`\`\`${next}\n\n`,
    );
  });
});
