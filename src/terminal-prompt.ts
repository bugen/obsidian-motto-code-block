import type { TerminalContext } from './codeblock';

type Marker = '$' | '#' | '>' | '%';

export interface TranscriptPrompt {
  text: string;
  language: 'bash' | 'zsh' | 'powershell';
  marker: Marker;
  context?: TerminalContext;
}

export type TranscriptShellMode = 'auto' | 'bash' | 'powershell';

export interface TerminalPromptPattern {
  id: string;
  source: string;
  enabled: boolean;
  name?: string;
}

export interface PromptMatch {
  prompt: TranscriptPrompt;
  command: string;
  approximate?: true;
}

export type PromptDetector = (line: string, reference: TranscriptPrompt | undefined) => PromptMatch | undefined;

const promptLimit = 192;
const comparisonLimit = 1_000_000;
const decoration = '(?:\\([^()\\s]{1,48}\\)|\\[[^\\[\\]\\s]{1,48}\\]|<[^<>\\s]{1,48}>)';
const leadingDecorations = new RegExp(`^(?:${decoration}[ \\t]+){1,3}`);
const decorationOnly = new RegExp(`^[ \\t]*(?:${decoration}[ \\t]*){0,3}$`);
const bashPrompt = /^([\w.-]+)@([\w.-]+):((?:~|\/)[^$#]*?)([$#])(?=[ \t]|$)/;
const powerShellPrompt = /^[Pp][Ss][ \t]+((?:[A-Za-z]:[\\/]|\\\\)[^>]*?)>(?=[ \t]|$)/;
const bareBashPrompt = /^([$#])(?=[ \t]|$)/;
const fallbackPrompt: Record<TranscriptShellMode, RegExp> = {
  auto: /^(?![ \t])[^$#>]*[$#>](?=[ \t]|$)/,
  bash: /^(?![ \t])[^$#]*[$#](?=[ \t]|$)/,
  powershell: /^(?![ \t])[^>]*>(?=[ \t]|$)/,
};
const endMarker = /[$#>%]$/;
const markerBoundary = /[$#>%](?=[ \t]|$)/;

const optionalDecorations = String.raw`(?:${decoration}[ \t]+){0,3}`;
export const DEFAULT_TERMINAL_PROMPT_PATTERNS: readonly Readonly<TerminalPromptPattern>[] = [
  { id: 'bash-user-host', name: 'Bash: user@host:~/work$', enabled: true,
    source: `^${optionalDecorations}${bashPrompt.source.slice(1)}` },
  { id: 'bash-bracketed', name: 'Bash: [user@host work]$', enabled: true,
    source: String.raw`^${optionalDecorations}\[[\w.-]+@[\w.-]+[ \t]+[^\]\r\n]+\][$#](?=[ \t]|$)` },
  { id: 'bash-version', name: 'Bash: bash-5.2$', enabled: true,
    source: String.raw`^${optionalDecorations}bash-\d+(?:\.\d+)+[$#](?=[ \t]|$)` },
  { id: 'zsh-macos', name: 'Zsh (macOS): user@host work %', enabled: true,
    source: String.raw`^${optionalDecorations}[\w.-]+@[\w.-]+[ \t]+[^% \t][^%\r\n]*?[ \t]+%(?=[ \t]|$)` },
  { id: 'zsh-host', name: 'Zsh: host%', enabled: true,
    source: String.raw`^${optionalDecorations}[A-Za-z_][\w.-]*%(?=[ \t]|$)` },
  { id: 'powershell-path', name: 'PowerShell: PS C:\\work>', enabled: true, source: powerShellPrompt.source },
];

export function compilePromptPatterns(sources: readonly string[]): { patterns: RegExp[]; invalid: number[] } {
  const patterns: RegExp[] = [];
  const invalid: number[] = [];
  for (const [index, source] of sources.entries()) {
    if (!source.trim()) continue;
    try {
      patterns.push(new RegExp(`^(?:${source})`, 'u'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      invalid.push(index + 1);
    }
  }
  return { patterns, invalid };
}

function isMarker(value: string | undefined): value is Marker {
  return value === '$' || value === '#' || value === '>' || value === '%';
}

export function literalPromptContext(text: string): TerminalContext | undefined {
  const core = text.replace(leadingDecorations, '');
  const bash = bashPrompt.exec(core);
  if (bash?.[0] === core) return { user: bash[1]!, host: bash[2]!, cwd: bash[3]! };
  const powershell = powerShellPrompt.exec(core);
  if (powershell?.[0] === core) return { cwd: powershell[1]! };
}

function matchPrompt(line: string, end: number): PromptMatch | undefined {
  const marker = line[end - 1];
  if (!isMarker(marker) || (end < line.length && line[end] !== ' ' && line[end] !== '\t')) return;
  const text = line.slice(0, end);
  const context = literalPromptContext(text);
  const language = marker === '>' ? 'powershell' : marker === '%' ? 'zsh' : 'bash';
  return {
    prompt: { text, marker, language, ...(context ? { context } : {}) },
    command: line.slice(end === line.length ? end : end + 1),
  };
}

function sameShape(candidate: TranscriptPrompt, reference: TranscriptPrompt): boolean {
  if (candidate.marker !== reference.marker) return false;
  if (candidate.text.replace(leadingDecorations, '') === reference.text.replace(leadingDecorations, '')) return true;
  if (candidate.language === 'powershell') return Boolean(candidate.context?.cwd && reference.context?.cwd);
  return candidate.context?.user !== undefined && candidate.context.user === reference.context?.user &&
    candidate.context.host === reference.context?.host;
}

// Break matches at complete decoration tokens so a common "[" cannot absorb part of a changed tag.
function decorationMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  const tokens = new RegExp(decoration, 'g');
  for (const match of text.matchAll(tokens)) {
    if (match.index !== undefined) mask.fill(1, match.index, match.index + match[0].length);
  }
  return mask;
}

export function createPromptDetector(patterns: readonly RegExp[] = [], mode: TranscriptShellMode = 'auto'): PromptDetector {
  const row = new Uint16Array(promptLimit + 1);
  let remaining = comparisonLimit;

  function supportsMode(result: PromptMatch): boolean {
    return mode === 'auto' || (mode === 'bash' ? result.prompt.language !== 'powershell' : result.prompt.language === mode);
  }

  function similar(candidate: string, reference: string): boolean {
    const cost = candidate.length * reference.length;
    if (Math.min(candidate.length, reference.length) < 6 || cost > remaining) return false;
    remaining -= cost;
    row.fill(0, 0, reference.length + 1);
    const aMask = decorationMask(candidate);
    const bMask = decorationMask(reference);
    let length = 0;
    let aEnd = 0;
    let bEnd = 0;
    for (let a = 1; a <= candidate.length; a++) {
      for (let b = reference.length; b > 0; b--) {
        const run = row[b] = !aMask[a - 1] && !bMask[b - 1] && candidate[a - 1] === reference[b - 1]
          ? row[b - 1]! + 1 : 0;
        if (run > length) {
          length = run;
          aEnd = a;
          bEnd = b;
        }
      }
    }
    const anchor = candidate.slice(aEnd - length, aEnd).trim();
    return anchor.length >= 6 && /[\p{L}\p{N}]/u.test(anchor) &&
      [candidate.slice(0, aEnd - length), candidate.slice(aEnd),
        reference.slice(0, bEnd - length), reference.slice(bEnd)].every((part) => decorationOnly.test(part));
  }

  return (line, reference) => {
    if (reference && line.startsWith(reference.text)) {
      const exact = matchPrompt(line, reference.text.length);
      if (exact && supportsMode(exact)) return exact;
    }
    const sample = line.slice(0, promptLimit + 1);
    if (!markerBoundary.test(sample)) return;
    let incompatiblePrompt = false;
    for (const pattern of patterns) {
      const match = pattern.exec(sample);
      if (match?.index === 0 && endMarker.test(match[0]) && match[0].length <= promptLimit) {
        const result = matchPrompt(line, match[0].length);
        if (result && supportsMode(result)) return result;
        if (result) incompatiblePrompt = true;
      }
    }
    if (incompatiblePrompt) return;
    const offset = leadingDecorations.exec(sample)?.[0].length ?? 0;
    const core = sample.slice(offset);
    const standard = bashPrompt.exec(core) ?? powerShellPrompt.exec(core) ?? bareBashPrompt.exec(core);
    if (standard) {
      const result = matchPrompt(line, offset + standard[0].length);
      if (result) {
        // A recognized prompt outweighs markers inside its command.
        if (!supportsMode(result)) return;
        if (!reference || sameShape(result.prompt, reference)) return result;
      }
    }
    const fallback = fallbackPrompt[mode].exec(core);
    if (!fallback || offset + fallback[0].length > promptLimit) return;
    const result = matchPrompt(line, offset + fallback[0].length);
    if (!result || !reference) return result;
    if (sameShape(result.prompt, reference)) return result;
    if (result.prompt.marker !== reference.marker || result.prompt.context || reference.context) return;
    if (similar(result.prompt.text.slice(0, -1), reference.text.slice(0, -1))) {
      return { ...result, approximate: true };
    }
  };
}
