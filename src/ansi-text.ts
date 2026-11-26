import ansiRegex from 'ansi-regex';

const escapes = ansiRegex();

// eslint-disable-next-line no-control-regex -- Keep LF as a Markdown line break.
const controls = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/gu;
// eslint-disable-next-line no-control-regex -- Match ANSI SGR control characters.
const sgr = /^(?:\u001b\[|\u009b)[\d;]*m$/u;

export function ansiText(text: string): string {
  return text.replace(escapes, '');
}

export function isAnsiSgr(sequence: string): boolean {
  return sgr.test(sequence);
}

export function trailingAnsiSgr(text: string): string {
  const suffix: string[] = [];
  let end = 0;
  for (const match of text.matchAll(escapes)) {
    const sequence = match[0];
    if (text.slice(end, match.index).trim()) suffix.length = 0;
    if (isAnsiSgr(sequence)) suffix.push(sequence);
    end = match.index + sequence.length;
  }
  return text.slice(end).trim() ? '' : suffix.join('');
}

export function encodeAnsiSource(text: string): string {
  return text.replaceAll('\\', '\\\\').replace(controls, (char) =>
    `\\x${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export function hasAnsiControls(text: string): boolean {
  return text.search(controls) !== -1;
}

export function decodeAnsiSource(text: string, raw?: true): string {
  if (raw || hasAnsiControls(text)) return text;
  return text.replace(/\\\\|\\x([0-9a-f]{2})/giu, (escape: string, hex?: string) => {
    if (hex === undefined) return '\\';
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return hasAnsiControls(char) ? char : escape;
  });
}
