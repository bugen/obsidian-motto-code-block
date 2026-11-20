export const DEFAULT_COMMAND_LANGUAGES = ['sh', 'bash', 'zsh', 'csh', 'fish', 'powershell'] as const;

export function commandPromptSymbol(language: string, user?: string): string {
  if (language === 'powershell') return '>';
  return user === 'root' ? '#' : '$';
}

export interface CommandRange {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
}

export function splitCommands(text: string, language: string): CommandRange[] {
  const commands: CommandRange[] = [];
  const continuation = language === 'powershell' ? /`+$/ : /\\+$/;
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
    continued = (line.match(continuation)?.[0].length ?? 0) % 2 === 1;
    if ((!continued || to === text.length) && text.slice(from, to).trim()) {
      commands.push({ from, to, startLine, endLine: lineNumber });
    }
    offset = to + 1;
  }
  return commands;
}
