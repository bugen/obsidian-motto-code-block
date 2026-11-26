import { Notice, type Editor, type EditorPosition } from 'obsidian';
import { padMarkdownBlock } from './markdown-insert';
import type { MottoSettings } from './settings';
import { compilePromptPatterns, createPromptDetector, type TranscriptShellMode } from './terminal-prompt';
import { formatTerminalTranscript, parseTerminalTranscript } from './terminal-transcript';

function samePosition(a: EditorPosition, b: EditorPosition): boolean {
  return a.line === b.line && a.ch === b.ch;
}

export async function pasteTerminalTranscript(
  editor: Editor, readClipboard: () => Promise<string>, isCurrent: () => boolean,
  settings: Pick<MottoSettings, 'terminalPromptPatterns' | 'terminalIgnoredCommandSuffixes'>,
  keepAnsi: boolean, mode: TranscriptShellMode,
): Promise<void> {
  const from = editor.getCursor('from');
  const to = editor.getCursor('to');
  const selected = editor.getSelection();
  const { patterns, invalid } = compilePromptPatterns(
    settings.terminalPromptPatterns.map(({ source, enabled }) => enabled ? source : ''),
  );
  const ignoredSuffixes = settings.terminalIgnoredCommandSuffixes.split(/\r?\n/).map((suffix) => suffix.trim()).filter(Boolean);
  if (invalid.length > 0) {
    new Notice(`Motto Code Block: Invalid terminal prompt pattern(s) at position ${invalid.join(', ')}.`);
    return;
  }
  let text: string;
  try {
    text = await readClipboard();
  } catch {
    new Notice('Motto Code Block: Could not read the clipboard.');
    return;
  }
  if (!isCurrent() || !samePosition(editor.getCursor('from'), from) ||
      !samePosition(editor.getCursor('to'), to) || editor.getSelection() !== selected) {
    new Notice('Motto Code Block: The paste location changed. Run the command again.');
    return;
  }
  const parsed = parseTerminalTranscript(text, createPromptDetector(patterns, mode), ignoredSuffixes);
  if ('error' in parsed) {
    const messages = {
      'missing-prompt': `The first line must start with ${mode === 'auto' ? 'a terminal' : mode === 'bash' ? 'a Bash' : 'a PowerShell'} prompt.`,
      'missing-command': 'No commands were found in the copied transcript.',
      'output-before-command': 'The copied transcript contains output before the first command.',
      'all-commands-ignored': 'All copied commands match an ignored command suffix.',
    };
    new Notice(`Motto Code Block: ${messages[parsed.error]}`);
    return;
  }
  editor.replaceSelection(padMarkdownBlock(editor, formatTerminalTranscript(parsed.entries, keepAnsi), from, to));
}
