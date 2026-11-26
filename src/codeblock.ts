import { parser } from '@lezer/markdown';
import { DEFAULT_SETTINGS, isLanguageEnabled, type MottoSettings } from './settings';

export interface TerminalContext {
  user?: string;
  host?: string;
  cwd?: string;
  promptText?: string;
  promptDisplay?: 'inline' | 'hide';
}

export type CommandSessionPosition = 'first' | 'middle' | 'last';

export interface TerminalBlock extends TerminalContext {
  output?: CodeBlock;
  session?: CommandSessionPosition;
  sessionFrom?: number;
}

export interface CodeBlock {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  lineCount: number;
  language: string;
  title: string;
  hasParameters: boolean;
  exclude?: boolean;
  unclosed?: true;
  terminal?: TerminalBlock;
  infoRange?: { from: number; to: number };
  commandFrom?: number;
  headerStyle?: string;
  fold?: boolean;
  previewLines?: number;
  ansiRaw?: true;
  text: string;
}

const foldOptions = new Map([['fold', true], ['expand', false], ['unfold', false]]);
const valueOptions = new Map([
  ['title', 'title'], ['file', 'file'], ['header-style', 'header-style'], ['prompt', 'prompt'],
  ['prompt-display', 'prompt-display'], ['prompt-text', 'prompt-text'],
  ['user', 'user'], ['host', 'host'], ['cwd', 'cwd'],
  ['directory', 'cwd'], ['dir', 'cwd'], ['wd', 'cwd'], ['pwd', 'cwd'],
]);

export interface Diagnostic {
  line: number;
  message: string;
}

function infoLanguage(info: string): { language: string; optionsFrom: number } {
  const trimmed = info.trimStart();
  const languageMatch = /^([^\s:=]+)(?=\s|$)/.exec(trimmed);
  const firstToken = languageMatch?.[1]?.toLowerCase() ?? '';
  const language = foldOptions.has(firstToken) || firstToken === 'exclude' ? '' : firstToken;
  return { language, optionsFrom: info.length - trimmed.length + (language ? languageMatch![0].length : 0) };
}

function* infoOptions(info: string, index: number) {
  while (index < info.length) {
    const space = index;
    while (index < info.length && /\s/.test(info[index]!)) index++;
    if (index === info.length) break;
    const from = index;
    while (index < info.length && !/[\s:=]/.test(info[index]!)) index++;
    const keyEnd = index;
    const key = info.slice(from, keyEnd).toLowerCase();
    while (index < info.length && /\s/.test(info[index]!)) index++;
    if (info[index] !== ':' && info[index] !== '=') {
      index = keyEnd;
      yield { key, space, from, to: keyEnd, value: undefined, unclosed: false };
      continue;
    }
    index++;
    while (index < info.length && /\s/.test(info[index]!)) index++;
    const quote = info[index];
    let value = '';
    if (quote === '"' || quote === "'") {
      index++;
      while (index < info.length && info[index] !== quote) {
        const char = info[index++]!;
        if (char === '\\' && (info[index] === quote || info[index] === '\\')) {
          value += info[index++]!;
        } else value += char;
      }
      if (info[index] !== quote) {
        yield { key, space, from, to: index, value, unclosed: true };
        break;
      }
      index++;
    } else {
      const valueStart = index;
      while (index < info.length && !/\s/.test(info[index]!)) index++;
      value = info.slice(valueStart, index);
    }
    yield { key, space, from, to: index, value, unclosed: false };
  }
}

export function updatePromptDisplayInfo(info: string, mode: 'hide' | 'inline' | 'header'): string | undefined {
  const options = [...infoOptions(info, infoLanguage(info).optionsFrom)];
  if (options.some(({ unclosed }) => unclosed)) return;
  const displays = options.filter(({ key }) => key === 'prompt-display');
  if (mode !== 'header' && displays.length === 0) {
    const end = info.trimEnd().length;
    return `${info.slice(0, end)} prompt-display:${mode}${info.slice(end)}`;
  }
  let edited = info;
  for (let index = displays.length - 1; index >= 0; index--) {
    const { space, from, to, value } = displays[index]!;
    const adjacent = to < edited.length && !/\s/.test(edited[to]!);
    if (index === 0 && mode !== 'header') {
      if (value?.toLowerCase() !== mode) {
        edited = `${edited.slice(0, from)}prompt-display:${mode}${adjacent ? ' ' : ''}${edited.slice(to)}`;
      }
    } else {
      edited = edited.slice(0, adjacent ? from : space) + edited.slice(to);
    }
  }
  return edited;
}

export function parseInfo(info: string): {
  language: string; title: string; hasParameters: boolean;
  exclude?: boolean;
  explicitCommand?: true;
  context?: TerminalContext;
  headerStyle?: string; fold?: boolean; previewLines?: number; ansiRaw?: true; diagnostics: string[];
} {
  const { language, optionsFrom } = infoLanguage(info);
  const values = new Map<string, string>();
  const diagnostics: string[] = [];
  let hasParameters = false;
  let hasPromptParameters = false;
  let fold: boolean | undefined;
  let previewLines: number | undefined;
  let command = false;
  let exclude = false;
  for (const { key, value, unclosed } of infoOptions(info, optionsFrom)) {
    const hasValue = value !== undefined;
    const valueKey = key === 'encoding' && language === 'ansi' ? key : valueOptions.get(key);
    if (hasValue && (valueKey === 'prompt' || valueKey === 'prompt-text' ||
      valueKey === 'user' || valueKey === 'host' || valueKey === 'cwd')) {
      hasPromptParameters = true;
    } else if (foldOptions.has(key) ||
      (hasValue && valueKey !== undefined && valueKey !== 'prompt-display' && valueKey !== 'encoding')) {
      hasParameters = true;
    }
    if (!hasValue) {
      if (foldOptions.has(key)) {
        fold = foldOptions.get(key);
        previewLines = undefined;
      } else if (key === 'cmd' || key === 'command') command = true;
      else if (key === 'exclude') exclude = true;
      else if (key === 'prompt-display') diagnostics.push('The "prompt-display" option requires "inline" or "hide".');
      else if (valueKey === 'encoding') diagnostics.push('The "encoding" option requires "raw".');
      continue;
    }
    if (unclosed) {
      diagnostics.push(`Unclosed quote in "${key}" option.`);
      break;
    }
    if (valueKey !== undefined) values.set(valueKey, value);
    if (key === 'expand' || key === 'unfold') {
      const count = Number(value);
      if (/^\d+$/.test(value) && Number.isSafeInteger(count) && count > 0) {
        fold = false;
        previewLines = count;
      } else diagnostics.push(`Invalid "${key}" line count. Use a positive whole number.`);
    } else if (key === 'fold' || key === 'cmd' || key === 'command' || key === 'exclude') {
      diagnostics.push(`The "${key}" option does not take a value.`);
    }
  }
  const headerStyle = values.get('header-style')?.toLowerCase();
  const validStyle = headerStyle !== undefined && /^[a-z0-9_-]+$/.test(headerStyle);
  if (headerStyle !== undefined && !validStyle) {
    diagnostics.push('Invalid "header-style" option. Use a callout type containing only letters, numbers, hyphens, or underscores.');
  }
  const context: TerminalContext = {};
  for (const key of ['user', 'host', 'cwd'] as const) {
    const value = values.get(key);
    if (value !== undefined) context[key] = value;
  }
  const prompt = values.get('prompt');
  if (prompt !== undefined && Object.keys(context).length === 0) {
    const parts = /^([^@:]*)(?:@([^@:]*)(?::(.*))?)?$/.exec(prompt);
    if (parts && prompt.length > 0) {
      context.user = parts[1]!;
      if (parts[2] !== undefined) context.host = parts[2];
      if (parts[3] !== undefined) context.cwd = parts[3];
    } else diagnostics.push('Invalid "prompt" option. Use "user", "user@host", or "user@host:cwd".');
  }
  const promptText = values.get('prompt-text');
  if (promptText !== undefined) {
    if (/[$#>%]$/.test(promptText)) context.promptText = promptText;
    else diagnostics.push('Invalid "prompt-text" option. End the prompt with "$", "#", ">", or "%".');
  }
  const promptDisplay = values.get('prompt-display')?.toLowerCase();
  if (promptDisplay === 'inline' || promptDisplay === 'hide') context.promptDisplay = promptDisplay;
  else if (promptDisplay !== undefined) {
    diagnostics.push('Invalid "prompt-display" value. Use "inline" or "hide".');
  }
  const encoding = values.get('encoding')?.toLowerCase();
  if (encoding !== undefined && encoding !== 'raw') diagnostics.push('Invalid "encoding" value. Use "raw".');
  return {
    language,
    title: values.get('file') || values.get('title') || '',
    hasParameters: hasParameters || (hasPromptParameters && context.promptDisplay === undefined),
    ...(exclude ? { exclude: true } : {}),
    ...(command ? { explicitCommand: true } : {}),
    ...(command || Object.keys(context).length ? { context } : {}),
    ...(validStyle ? { headerStyle } : {}),
    ...(fold !== undefined ? { fold } : {}),
    ...(previewLines !== undefined ? { previewLines } : {}),
    ...(encoding === 'raw' ? { ansiRaw: true } : {}),
    diagnostics,
  };
}

function frontmatterEnd(source: string): number {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(source);
  if (!opening) return 0;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(source);
  return match ? match.index + match[0].length : source.length;
}

function lineAt(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle]! <= position) low = middle;
    else high = middle;
  }
  return low;
}

export function isCodeBlockEnabled(
  block: CodeBlock, settings: Pick<MottoSettings, 'commandBlocks' | 'languageIncludeList' | 'languageExcludeList'>,
): boolean {
  return !block.exclude && (Boolean(settings.commandBlocks && block.terminal) || isLanguageEnabled(block.language, settings));
}

export function parseCodeBlocks(
  source: string,
  settings: Pick<MottoSettings, 'commandBlocks' | 'commandLanguages' | 'outputLanguages' |
    'languageIncludeList' | 'languageExcludeList'> = DEFAULT_SETTINGS,
): { blocks: CodeBlock[]; diagnostics: Diagnostic[] } {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  const base = frontmatterEnd(source);
  const blocks: CodeBlock[] = [];
  const pendingDiagnostics = new Map<number, string[]>();
  const adjacent = new Set<number>();
  const explicitCommands = new Set<number>();
  const isCommandLanguage = (language: string) => settings.commandBlocks &&
    settings.commandLanguages.includes(language) && !settings.languageExcludeList.includes(language);
  parser.parse(source.slice(base)).iterate({
    enter(ref) {
      if (ref.name !== 'FencedCode') return;
      const node = ref.node;
      const infoNode = node.getChild('CodeInfo');
      const info = parseInfo(infoNode ? source.slice(base + infoNode.from, base + infoNode.to) : '');
      const startLine = lineAt(starts, base + node.from);
      const endLine = lineAt(starts, base + node.to);
      const closed = node.getChildren('CodeMark').length > 1;
      const isExplicitCommand = info.explicitCommand && !info.exclude && isCommandLanguage(info.language);
      if (isExplicitCommand) {
        explicitCommands.add(starts[startLine]!);
      }
      if (info.diagnostics.length > 0) pendingDiagnostics.set(startLine, info.diagnostics);
      blocks.push({
        from: starts[startLine]!,
        to: base + node.to,
        startLine,
        endLine,
        lineCount: Math.max(0, endLine - startLine - (closed ? 1 : 0)),
        language: info.language,
        title: info.title,
        hasParameters: info.hasParameters,
        ...(isExplicitCommand && infoNode ? { infoRange: { from: base + infoNode.from, to: base + infoNode.to } } : {}),
        ...(info.exclude ? { exclude: true } : {}),
        ...(!closed ? { unclosed: true } : {}),
        ...(!info.exclude && info.context && isCommandLanguage(info.language) ? { terminal: { ...info.context } } : {}),
        ...(info.headerStyle !== undefined ? { headerStyle: info.headerStyle } : {}),
        ...(info.fold !== undefined ? { fold: info.fold } : {}),
        ...(info.previewLines !== undefined ? { previewLines: info.previewLines } : {}),
        ...(info.ansiRaw ? { ansiRaw: true } : {}),
        text: node.getChildren('CodeText').map((part) => {
          let end = base + part.to;
          if (source[end - 1] === '\r' && source[end] === '\n') end--;
          return source.slice(base + part.from, end);
        }).join('').replaceAll('\r\n', '\n'),
      });
      let next = node.nextSibling;
      while (next?.name === 'QuoteMark') next = next.nextSibling;
      if (closed && next?.name === 'FencedCode' &&
          lineAt(starts, base + next.from) === endLine + 1) {
        adjacent.add(starts[startLine]!);
      }
      return false;
    },
  });
  for (let index = 0; index + 1 < blocks.length; index++) {
    const command = blocks[index]!;
    const output = blocks[index + 1]!;
    if (command.exclude || output.exclude || command.commandFrom !== undefined || explicitCommands.has(output.from) ||
        !isCommandLanguage(command.language) || !settings.outputLanguages.includes(output.language || 'plaintext') ||
        !adjacent.has(command.from) || !isLanguageEnabled(output.language, settings)) continue;
    command.terminal ??= {};
    command.terminal.output = output;
    output.commandFrom = command.from;
  }
  for (let index = 0; index + 1 < blocks.length; index++) {
    const command = blocks[index]!;
    if (!explicitCommands.has(command.from) || !command.terminal) continue;
    const next = blocks[index + (command.terminal.output ? 2 : 1)];
    if (!next?.terminal || !explicitCommands.has(next.from) ||
        !adjacent.has(command.terminal.output?.from ?? command.from)) continue;
    command.terminal.session = command.terminal.session === 'last' ? 'middle' : 'first';
    command.terminal.sessionFrom ??= command.from;
    next.terminal.session = 'last';
    next.terminal.sessionFrom = command.terminal.sessionFrom;
  }
  const diagnostics = blocks.flatMap((block) =>
    isCodeBlockEnabled(block, settings)
      ? (pendingDiagnostics.get(block.startLine) ?? []).map((message) => ({ line: block.startLine, message }))
      : []);
  return { blocks, diagnostics };
}

export function reportDiagnostics(diagnostics: Diagnostic[], path: string): void {
  for (const diagnostic of diagnostics) {
    console.warn(`[Motto Code Block] ${path}:${diagnostic.line + 1}: ${diagnostic.message}`);
  }
}
