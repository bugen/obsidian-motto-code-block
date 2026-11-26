// @vitest-environment happy-dom
import { App, TFile, type Command, type Editor, type EditorPosition } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import MottoCodeBlockPlugin from '../src/main';
import { MarkdownView, Notice } from './obsidian';

const fallback = 'Sorry... To see this block, open this note in Obsidian with the Motto Code Block plugin installed.\n' +
  'https://github.com/bugen/obsidian-motto-code-block';
const markdown = `\`\`\`hippo big\n${fallback}\n\`\`\``;

async function fixture(source: string, cursor: EditorPosition, name = 'Hippo Big') {
  const lines = source.split('\n');
  const transaction = vi.fn<Editor['transaction']>();
  const editor = Object.assign({} as Editor, {
    getCursor: () => cursor,
    getValue: () => source,
    posToOffset: ({ line, ch }: EditorPosition) => lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, ch),
    getLine: (line: number) => lines[line]!,
    lastLine: () => lines.length - 1,
    transaction,
  });
  const app = Object.assign(new App(), { workspace: { on: vi.fn() } });
  const getMode = vi.fn<() => 'source' | 'preview'>(() => 'source');
  const view = Object.assign(new MarkdownView(), {
    editor, getMode, file: new TFile(), app, containerEl: document.body, hoverPopover: null,
  });
  const commands: Command[] = [];
  const plugin = Object.assign(new MottoCodeBlockPlugin(app, {
    id: 'motto-code-block', name: 'Motto Code Block', version: '0.1.1',
    minAppVersion: '1.5.0', author: '', description: '',
  }), {
    app, loadData: async () => null, register: vi.fn(), registerMarkdownPostProcessor: vi.fn(),
    registerEvent: vi.fn(), registerEditorExtension: vi.fn(), addSettingTab: vi.fn(),
    addCommand: (command: Command) => commands.push(command),
  });
  await plugin.onload();
  const command = commands.find((command) => command.name === name)!;
  return { transaction, getMode, run: (checking = false) => command.editorCheckCallback!(checking, editor, view) };
}

afterEach(() => { Notice.messages.length = 0; });

it.each([
  ['', { line: 0, ch: 0 }, `${markdown}\n`, 4],
  ['Beforeafter', { line: 0, ch: 6 }, `\n\n${markdown}\n\n`, 7],
])('inserts a complete fence at the cursor without replacing nearby text (%j)', async (source, cursor, text, line) => {
  const { transaction, getMode, run } = await fixture(source, cursor);
  getMode.mockReturnValue('preview');
  expect(run(true)).toBe(false);
  getMode.mockReturnValue('source');
  expect(run(true)).toBe(true);
  expect(transaction).not.toHaveBeenCalled();
  expect(run()).toBe(true);
  expect(transaction).toHaveBeenCalledExactlyOnceWith({
    changes: [{ from: cursor, text }],
    selection: { from: { line, ch: 0 } },
  });
});

it('inserts a Hippo Farm fence with fallback text and no options, leaving the cursor after it', async () => {
  const cursor = { line: 0, ch: 6 };
  const { transaction, getMode, run } = await fixture('Beforeafter', cursor, 'Hippo Farm');
  getMode.mockReturnValue('preview');
  expect(run(true)).toBe(false);
  getMode.mockReturnValue('source');
  expect(run(true)).toBe(true);
  expect(transaction).not.toHaveBeenCalled();
  expect(run()).toBe(true);
  expect(transaction).toHaveBeenCalledExactlyOnceWith({
    changes: [{ from: cursor, text: `\n\n\`\`\`hippo farm\n${fallback}\n\`\`\`\n\n` }],
    selection: { from: { line: 7, ch: 0 } },
  });
});

it.each([
  ['```txt\nexisting code\n```', { line: 1, ch: 0 }],
  ['---\ntags: [demo]\n---\nBody', { line: 0, ch: 0 }],
])('does not damage an existing fence or note properties (%j)', async (source, cursor) => {
  const { transaction, run } = await fixture(source, cursor);
  run();
  expect(transaction).not.toHaveBeenCalled();
  expect(Notice.messages).toEqual([expect.stringContaining('Move the cursor outside code blocks or note properties')]);
});
