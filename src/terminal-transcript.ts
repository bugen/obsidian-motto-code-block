import { ansiText, encodeAnsiSource, trailingAnsiSgr } from './ansi-text';
import { continuesCommand, formatCommandPrompt } from './commands';
import { createPromptDetector, type PromptDetector, type TranscriptPrompt } from './terminal-prompt';

export interface TranscriptEntry {
  prompt: TranscriptPrompt;
  command: string;
  output: readonly string[];
}

export type TranscriptResult = { entries: TranscriptEntry[] } |
  { error: 'missing-prompt' | 'missing-command' | 'output-before-command' | 'all-commands-ignored' };

export function parseTerminalTranscript(
  text: string, detect: PromptDetector = createPromptDetector(), ignoredCommandSuffixes: readonly string[] = [],
): TranscriptResult {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let lastCommandLine = lines[0] ?? '';
  const first = detect(ansiText(lastCommandLine), undefined);
  if (!first) return { error: 'missing-prompt' };

  const entries: TranscriptEntry[] = [];
  let reference = first.prompt;
  let prompt = first.prompt;
  let command = first.command.trim() ? [first.command] : [];
  let output: string[] = [];
  let hasOutput = false;
  let seenCommand = command.length > 0;
  let continued = seenCommand && continuesCommand(first.command, prompt.language);
  let ignored = false;
  const flush = () => {
    if (command.length === 0 && !hasOutput) return;
    const text = command.join('\n');
    const input = text.trimEnd();
    if (ignoredCommandSuffixes.some((suffix) =>
      suffix && (input.endsWith(suffix) || (suffix === '^C' && input.endsWith('\u0003'))))) {
      ignored = true;
      return;
    }
    entries.push({ prompt, command: text, output });
  };

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = ansiText(raw);
    if (continued) {
      const body = line.replace(prompt.language === 'powershell' ? /^>>[ \t]/ : /^>[ \t]/, '');
      command.push(body);
      lastCommandLine = raw;
      continued = continuesCommand(body, prompt.language);
      continue;
    }
    const next = detect(line, reference);
    if (next) {
      flush();
      prompt = next.prompt;
      if (!next.approximate) reference = prompt;
      command = next.command.trim() ? [next.command] : [];
      lastCommandLine = raw;
      output = [];
      hasOutput = false;
      seenCommand ||= command.length > 0;
      continued = command.length > 0 && continuesCommand(next.command, prompt.language);
    } else if (seenCommand) {
      output.push(output.length === 0 ? trailingAnsiSgr(lastCommandLine) + raw : raw);
      hasOutput ||= line.trim().length > 0;
    } else if (line.trim()) {
      return { error: 'output-before-command' };
    }
  }
  flush();
  return entries.length > 0 ? { entries } : { error: ignored ? 'all-commands-ignored' : 'missing-command' };
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function fence(info: string, body: string): string {
  let length = 3;
  const tilde = info.includes('`');
  for (const match of body.matchAll(tilde ? /~{3,}/g : /`{3,}/g)) length = Math.max(length, match[0].length + 1);
  const mark = (tilde ? '~' : '`').repeat(length);
  return `${mark}${info}\n${body ? `${body}\n` : ''}${mark}`;
}

export function formatTerminalTranscript(entries: readonly TranscriptEntry[], keepAnsi: boolean): string {
  const fences: string[] = [];
  for (const { prompt, command, output } of entries) {
    const context = prompt.context;
    let info = `${prompt.language} cmd`;
    if (context?.user && context.host && context.cwd) {
      info += ` prompt:${quote(`${context.user}@${context.host}:${context.cwd}`)}`;
    } else if (context?.cwd) {
      info += ` cwd:${quote(context.cwd)}`;
    }
    const formatted = formatCommandPrompt(prompt.language, { ...context, promptDisplay: 'hide' });
    const needsText = prompt.text !== (formatted.tooltip || formatted.symbol);
    if (needsText) info += ` prompt-text:${quote(prompt.text)}`;
    if (needsText || context?.cwd) info += ' prompt-display:hide';
    fences.push(fence(info, command));
    if (output.length > 0) {
      const body = output.join('\n');
      fences.push(fence(keepAnsi ? 'ansi' : 'plaintext', keepAnsi ? encodeAnsiSource(body) : ansiText(body)));
    }
  }
  return fences.join('\n');
}
