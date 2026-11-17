export const SHELL_LANGUAGES = ['sh', 'bash', 'zsh', 'csh', 'fish'] as const;

export function isShell(language: string): boolean {
  return SHELL_LANGUAGES.some((shell) => shell === language);
}

export interface CommandRange {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
}

export function splitCommands(text: string): CommandRange[] {
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
    continued = (line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1;
    if ((!continued || to === text.length) && text.slice(from, to).trim()) {
      commands.push({ from, to, startLine, endLine: lineNumber });
    }
    offset = to + 1;
  }
  return commands;
}
