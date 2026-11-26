import type { Editor, EditorPosition } from 'obsidian';

export function padMarkdownBlock(editor: Editor, markdown: string, from: EditorPosition, to = from): string {
  const before = editor.getLine(from.line).slice(0, from.ch);
  const after = editor.getLine(to.line).slice(to.ch);
  const leading = before.trim() ? '\n\n'
    : before.length || (from.line > 0 && editor.getLine(from.line - 1).trim()) ? '\n' : '';
  const trailing = after.trim() || (!after.length && to.line < editor.lastLine() && editor.getLine(to.line + 1).trim())
    ? '\n\n' : '\n';
  return leading + markdown + trailing;
}
