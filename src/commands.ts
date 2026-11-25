import type { TerminalContext } from './codeblock';

export const DEFAULT_COMMAND_LANGUAGES = ['sh', 'bash', 'zsh', 'csh', 'fish', 'powershell'] as const;

export interface CommandPrompt {
  symbol: string;
  inlineContext: string;
  tooltip: string;
}

export function formatCommandPrompt(language: string, terminal?: TerminalContext): CommandPrompt {
  const text = terminal?.promptText;
  const symbol = text?.slice(-1) || (language === 'powershell' ? '>' : terminal?.user === 'root' ? '#' : '$');
  const identity = [terminal?.user, terminal?.host].filter(Boolean).join('@');
  const context = text ? text.slice(0, -1) : [identity, terminal?.cwd].filter(Boolean).join(':');
  return {
    symbol,
    inlineContext: terminal?.promptDisplay === 'inline' ? context : '',
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
