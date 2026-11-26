import type { TerminalContext } from './codeblock';
import { literalPromptContext } from './terminal-prompt';

export const DEFAULT_COMMAND_LANGUAGES = ['sh', 'bash', 'zsh', 'csh', 'fish', 'powershell'] as const;

interface PromptPart {
  field?: 'user' | 'host' | 'cwd';
  text: string;
}

export interface CommandPrompt {
  symbol: string;
  inlineContext: string;
  inlineParts?: readonly PromptPart[];
  tooltip: string;
}

function promptParts({ user, host, cwd }: TerminalContext): PromptPart[] {
  const parts: PromptPart[] = [];
  if (user) parts.push({ field: 'user', text: user });
  if (user && host) parts.push({ text: '@' });
  if (host) parts.push({ field: 'host', text: host });
  if ((user || host) && cwd) parts.push({ text: ':' });
  if (cwd) parts.push({ field: 'cwd', text: cwd });
  return parts;
}

function literalPromptParts(text: string, context: string): PromptPart[] | undefined {
  const fields = literalPromptContext(text);
  if (!fields) return;
  const parts = promptParts(fields);
  const suffix = parts.map((part) => part.text).join('');
  if (!context.endsWith(suffix)) return;
  const prefix = context.slice(0, context.length - suffix.length);
  if (prefix) parts.unshift({ text: prefix });
  return parts;
}

export function formatCommandPrompt(language: string, terminal?: TerminalContext): CommandPrompt {
  const text = terminal?.promptText;
  const symbol = text?.slice(-1) || (language === 'powershell' ? '>' : terminal?.user === 'root' ? '#' : '$');
  const generatedParts = terminal ? promptParts(terminal) : [];
  const generated = generatedParts.map((part) => part.text).join('');
  const context = text ? text.slice(0, -1) : generated;
  const inlineContext = terminal?.promptDisplay === 'inline' ? context : '';
  const parts = inlineContext ? (text && context !== generated ? literalPromptParts(text, context) : generatedParts) : undefined;
  return {
    symbol,
    inlineContext,
    ...(parts ? { inlineParts: parts } : {}),
    tooltip: context && terminal?.promptDisplay ? `${context}${symbol}` : '',
  };
}

export interface CommandRange {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
}

export function continuesCommand(line: string, language: string): boolean {
  const suffix = language === 'powershell' ? /`+$/ : /\\+$/;
  return (line.match(suffix)?.[0].length ?? 0) % 2 === 1;
}

export function splitCommands(text: string, language: string): CommandRange[] {
  const commands: CommandRange[] = [];
  let offset = 0;
  let from = 0;
  let startLine = 0;
  let continued = false;
  for (const [lineNumber, line] of text.split('\n').entries()) {
    if (!continued) {
      from = offset;
      startLine = lineNumber;
    }
    const to = offset + line.length;
    continued = continuesCommand(line, language);
    if ((!continued || to === text.length) && text.slice(from, to).trim()) {
      commands.push({ from, to, startLine, endLine: lineNumber });
    }
    offset = to + 1;
  }
  return commands;
}
