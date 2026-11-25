import ansiRegex from 'ansi-regex';

const escapes = ansiRegex();

export function ansiText(text: string): string {
  return text.replace(escapes, '');
}
