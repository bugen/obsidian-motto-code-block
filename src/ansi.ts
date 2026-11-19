import Anser from 'anser';
import ansiRegex from 'ansi-regex';

export function ansiText(text: string): string {
  return text.replace(ansiRegex(), '');
}

function ansiColor(color: string, trueColor: string): string {
  if (color === 'ansi-truecolor') return `rgb(${trueColor})`;
  if (color.startsWith('ansi-palette-')) {
    const index = Number(color.slice('ansi-palette-'.length));
    if (index >= 232) {
      const gray = 8 + (index - 232) * 10;
      return `rgb(${gray}, ${gray}, ${gray})`;
    }
    const cube = index - 16;
    const channel = (value: number) => value === 0 ? 0 : 55 + value * 40;
    return `rgb(${channel(Math.floor(cube / 36))}, ${channel(Math.floor(cube / 6) % 6)}, ${channel(cube % 6)})`;
  }
  return `var(--motto-${color})`;
}

export function renderAnsi(document: Document, text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const parser = new Anser();
  // eslint-disable-next-line no-control-regex -- Match ANSI SGR control characters.
  const sgr = /^(?:\u001b\[|\u009b)[\d;]*m$/u;
  const styled = text.replace(ansiRegex(), (sequence) =>
    sgr.test(sequence) ? sequence.replace('\u009b', '\u001b[') : '');
  for (const [index, part] of styled.split('\u001b[').entries()) {
    // Parse SGR chunks directly so reverse video can use the theme's defaults.
    const entry = parser.processChunkJson(index === 0 ? `0m${part}` : part, { use_classes: true }, true);
    if (!entry.content) continue;
    const span = fragment.createSpan();
    span.textContent = entry.content;
    const foreground = entry.fg ? ansiColor(entry.fg, entry.fg_truecolor) : undefined;
    const background = entry.bg ? ansiColor(entry.bg, entry.bg_truecolor) : undefined;
    if (entry.decorations.includes('reverse')) {
      span.style.color = background ?? 'var(--motto-output-background)';
      span.style.backgroundColor = foreground ?? 'var(--text-normal)';
    } else {
      if (foreground) span.style.color = foreground;
      if (background) span.style.backgroundColor = background;
    }
    for (const decoration of ['bold', 'dim', 'italic', 'hidden', 'underline', 'strikethrough'] as const) {
      if (entry.decorations.includes(decoration)) span.classList.add(`motto-ansi-${decoration}`);
    }
  }
  return fragment;
}
