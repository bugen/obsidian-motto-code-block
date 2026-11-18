import { parser } from '@lezer/markdown';
import { isShell } from './commands';

export interface TerminalContext {
  user?: string;
  host?: string;
  cwd?: string;
}

export interface TerminalBlock extends TerminalContext {
  output?: CodeBlock;
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
  terminal?: TerminalBlock;
  commandFrom?: number;
  headerStyle?: string;
  fold?: boolean;
  previewLines?: number;
  text: string;
}

const foldOptions = new Map([['fold', true], ['expand', false], ['unfold', false]]);
const valueOptions = new Map([
  ['title', 'title'], ['file', 'file'], ['header-style', 'header-style'], ['prompt', 'prompt'],
  ['user', 'user'], ['host', 'host'], ['cwd', 'cwd'],
  ['directory', 'cwd'], ['dir', 'cwd'], ['wd', 'cwd'], ['pwd', 'cwd'],
]);

export interface Diagnostic {
  line: number;
  message: string;
}

export function parseInfo(info: string): {
  language: string; title: string; hasParameters: boolean;
  exclude?: boolean;
  context?: TerminalContext;
  headerStyle?: string; fold?: boolean; previewLines?: number; diagnostics: string[];
} {
  const languageMatch = /^([^\s:=]+)(?=\s|$)/.exec(info.trimStart());
  const firstToken = languageMatch?.[1]?.toLowerCase() ?? '';
  const language = foldOptions.has(firstToken) || firstToken === 'exclude' ? '' : firstToken;
  const options = info.trimStart().slice(language ? languageMatch?.[0].length ?? 0 : 0);
  const values = new Map<string, string>();
  const diagnostics: string[] = [];
  let hasParameters = false;
  let fold: boolean | undefined;
  let previewLines: number | undefined;
  let command = false;
  let exclude = false;
  let index = 0;
  while (index < options.length) {
    while (/\s/.test(options[index] ?? '') && index < options.length) index++;
    const start = index;
    while (index < options.length && !/[\s:=]/.test(options[index]!)) index++;
    const key = options.slice(start, index).toLowerCase();
    while (index < options.length && /\s/.test(options[index]!)) index++;
    const hasValue = options[index] === ':' || options[index] === '=';
    const valueKey = valueOptions.get(key);
    if (foldOptions.has(key) || (hasValue && valueKey !== undefined)) hasParameters = true;
    if (!hasValue) {
      if (foldOptions.has(key)) {
        fold = foldOptions.get(key);
        previewLines = undefined;
      } else if (key === 'cmd' || key === 'command') command = true;
      else if (key === 'exclude') exclude = true;
      continue;
    }
    index++;
    while (index < options.length && /\s/.test(options[index]!)) index++;
    const quote = options[index];
    let value = '';
    if (quote === '"' || quote === "'") {
      index++;
      while (index < options.length && options[index] !== quote) {
        const char = options[index++]!;
        if (char === '\\' && (options[index] === quote || options[index] === '\\')) {
          value += options[index++]!;
        } else value += char;
      }
      if (options[index] !== quote) {
        diagnostics.push(`Unclosed quote in "${key}" option.`);
        break;
      }
      index++;
    } else {
      const valueStart = index;
      while (index < options.length && !/\s/.test(options[index]!)) index++;
      value = options.slice(valueStart, index);
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
  return {
    language,
    title: values.get('file') || values.get('title') || '',
    hasParameters,
    ...(exclude ? { exclude: true } : {}),
    ...(command || Object.keys(context).length ? { context } : {}),
    ...(validStyle ? { headerStyle } : {}),
    ...(fold !== undefined ? { fold } : {}),
    ...(previewLines !== undefined ? { previewLines } : {}),
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

export function parseCodeBlocks(
  source: string, isEnabled: (language: string) => boolean = () => true,
  outputLanguages: readonly string[] = ['ansi'],
): { blocks: CodeBlock[]; diagnostics: Diagnostic[] } {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  const base = frontmatterEnd(source);
  const blocks: CodeBlock[] = [];
  const diagnostics: Diagnostic[] = [];
  const adjacent = new Set<number>();
  parser.parse(source.slice(base)).iterate({
    enter(ref) {
      if (ref.name !== 'FencedCode') return;
      const node = ref.node;
      const infoNode = node.getChild('CodeInfo');
      const info = parseInfo(infoNode ? source.slice(base + infoNode.from, base + infoNode.to) : '');
      const startLine = lineAt(starts, base + node.from);
      const endLine = lineAt(starts, base + node.to);
      // Keep every fence for native-DOM matching, but only diagnose and pair eligible blocks.
      if (!info.exclude && isEnabled(info.language)) {
        for (const message of info.diagnostics) diagnostics.push({ line: startLine, message });
      }
      blocks.push({
        from: starts[startLine]!,
        to: base + node.to,
        startLine,
        endLine,
        lineCount: Math.max(0, endLine - startLine - (node.getChildren('CodeMark').length > 1 ? 1 : 0)),
        language: info.language,
        title: info.title,
        hasParameters: info.hasParameters,
        ...(info.exclude ? { exclude: true } : {}),
        ...(!info.exclude && isShell(info.language) && info.context ? { terminal: { ...info.context } } : {}),
        ...(info.headerStyle !== undefined ? { headerStyle: info.headerStyle } : {}),
        ...(info.fold !== undefined ? { fold: info.fold } : {}),
        ...(info.previewLines !== undefined ? { previewLines: info.previewLines } : {}),
        text: node.getChildren('CodeText').map((part) => {
          let end = base + part.to;
          if (source[end - 1] === '\r' && source[end] === '\n') end--;
          return source.slice(base + part.from, end);
        }).join('').replaceAll('\r\n', '\n'),
      });
      let next = node.nextSibling;
      while (next?.name === 'QuoteMark') next = next.nextSibling;
      if (node.getChildren('CodeMark').length > 1 && next?.name === 'FencedCode' &&
          lineAt(starts, base + next.from) === endLine + 1) {
        adjacent.add(starts[startLine]!);
      }
      return false;
    },
  });
  for (let index = 0; index + 1 < blocks.length; index++) {
    const command = blocks[index]!;
    const output = blocks[index + 1]!;
    if (command.exclude || output.exclude || command.commandFrom !== undefined ||
        !isShell(command.language) || !outputLanguages.includes(output.language || 'plaintext') ||
        !adjacent.has(command.from) ||
        !isEnabled(command.language) || !isEnabled(output.language)) continue;
    command.terminal ??= {};
    command.terminal.output = output;
    output.commandFrom = command.from;
  }
  return { blocks, diagnostics };
}

export function reportDiagnostics(diagnostics: Diagnostic[], path: string): void {
  for (const diagnostic of diagnostics) {
    console.warn(`[Motto Codeblock] ${path}:${diagnostic.line + 1}: ${diagnostic.message}`);
  }
}
