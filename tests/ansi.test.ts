// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './obsidian';
import { ansiText, renderAnsi } from '../src/ansi';

beforeEach(() => {
  const stylesheet = document.createElement('style');
  stylesheet.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
  document.head.append(stylesheet);
});

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

function render(text: string) {
  const code = document.createElement('code');
  code.className = 'motto-ansi-view';
  code.append(renderAnsi(document, text));
  document.body.append(code);
  return code;
}

describe('static ANSI output', () => {
  it('renders colors, truecolor, decorations and resets without bleeding into earlier text', () => {
    const code = render('plain\x1b[31mred\x1b[1mbold\x1b[0mnormal\x1b[38;2;1;2;3;48;5;22;3;4;9mstyled');
    const spans = [...code.querySelectorAll('span')];
    expect(code.textContent).toBe('plainredboldnormalstyled');
    expect(spans[0]?.style.color).toBe('');
    expect(spans[1]?.style.color).toBe('var(--motto-ansi-red)');
    expect(getComputedStyle(spans[1]!).fontWeight).not.toBe('bold');
    expect(getComputedStyle(spans[2]!).fontWeight).toBe('bold');
    expect(spans[3]?.style.color).toBe('');
    expect(spans[4]?.style.color).toBe('rgb(1, 2, 3)');
    expect(spans[4]?.style.backgroundColor).toBe('rgb(0, 95, 0)');
    expect(getComputedStyle(spans[4]!).fontStyle).toBe('italic');
    expect(getComputedStyle(spans[4]!).textDecoration).toBe('underline line-through');
  });

  it('applies dim and hidden decorations through CSS and resets subsequent text', () => {
    const spans = [...render('\x1b[2;8mdim hidden\x1b[0mnormal').querySelectorAll('span')];
    expect(getComputedStyle(spans[0]!).opacity).toBe('0.5');
    expect(getComputedStyle(spans[0]!).visibility).toBe('hidden');
    expect(getComputedStyle(spans[1]!).opacity).not.toBe('0.5');
    expect(getComputedStyle(spans[1]!).visibility).not.toBe('hidden');
  });

  it('uses theme colors for the standard foreground/background palette and its bright variants', () => {
    const colors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
    const text = colors.map((_, index) =>
      `\x1b[${30 + index};${40 + index}mnormal\x1b[${90 + index};${100 + index}mbright`).join('');
    const spans = [...render(text).querySelectorAll('span')];
    for (const [index, color] of colors.entries()) {
      const base = `var(--motto-ansi-${color})`;
      expect(spans[index * 2]?.style.color).toBe(base);
      expect(spans[index * 2]?.style.backgroundColor).toBe(base);
      const bright = `var(--motto-ansi-bright-${color})`;
      expect(spans[index * 2 + 1]?.style.color).toBe(bright);
      expect(spans[index * 2 + 1]?.style.backgroundColor).toBe(bright);
    }
  });

  it('preserves explicit RGB and indexed cube/grayscale colors while switching back to theme colors', () => {
    const spans = [...render(
      '\x1b[38;2;1;2;3;48;2;4;5;6mRGB\x1b[31;44mtheme' +
      '\x1b[38;5;196;48;5;232mindexed\x1b[38;5;231;48;5;255mend\x1b[39;49mreset',
    ).querySelectorAll('span')];
    expect(spans[0]?.style.color).toBe('rgb(1, 2, 3)');
    expect(spans[0]?.style.backgroundColor).toBe('rgb(4, 5, 6)');
    expect(spans[1]?.style.color).toBe('var(--motto-ansi-red)');
    expect(spans[1]?.style.backgroundColor).toBe('var(--motto-ansi-blue)');
    expect(spans[2]?.style.color).toBe('rgb(255, 0, 0)');
    expect(spans[2]?.style.backgroundColor).toBe('rgb(8, 8, 8)');
    expect(spans[3]?.style.color).toBe('rgb(255, 255, 255)');
    expect(spans[3]?.style.backgroundColor).toBe('rgb(238, 238, 238)');
    expect(spans[4]?.style.color).toBe('');
    expect(spans[4]?.style.backgroundColor).toBe('');
    const indexed = [...render('\x1b[38;5;1;48;5;12mtheme').querySelectorAll('span')];
    expect(indexed[0]?.style.color).toBe('var(--motto-ansi-red)');
    expect(indexed[0]?.style.backgroundColor).toBe('var(--motto-ansi-bright-blue)');
  });

  it('reverses themed defaults and explicit colors, including truecolor, without losing resets', () => {
    const spans = [...render(
      '\x1b[7mdefault\x1b[31mred\x1b[27mnormal\x1b[0;7;38;2;1;2;3mRGB\x1b[0mreset',
    ).querySelectorAll('span')];
    expect(spans[0]?.style.color).toBe('var(--motto-output-background)');
    expect(spans[0]?.style.backgroundColor).toBe('var(--text-normal)');
    expect(spans[1]?.style.color).toBe('var(--motto-output-background)');
    expect(spans[1]?.style.backgroundColor).toBe('var(--motto-ansi-red)');
    expect(spans[2]?.style.color).toBe('var(--motto-ansi-red)');
    expect(spans[2]?.style.backgroundColor).toBe('');
    expect(spans[3]?.style.color).toBe('var(--motto-output-background)');
    expect(spans[3]?.style.backgroundColor).toBe('rgb(1, 2, 3)');
    expect(spans[4]?.style.color).toBe('');
    expect(spans[4]?.style.backgroundColor).toBe('');
  });

  it('preserves styling across newlines and ignores cursor movement without emulating a terminal', () => {
    const code = render('\x1b[32mfirst\n\x1b[2Jsecond\x1b[0m');
    expect(code.textContent).toBe('first\nsecond');
    expect([...code.querySelectorAll('span')].every((span) => span.style.color !== '')).toBe(true);
  });

  it('renders HTML literally and strips OSC hyperlinks and clipboard sequences', () => {
    const text = '\x1b]8;;https://example.com\x07<img src=x onerror=alert(1)>\x1b]8;;\x07\x1b]52;c;c2VjcmV0\x07';
    const code = render(text);
    expect(code.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(code.querySelector('img, a, script')).toBeNull();
    expect(ansiText(text)).toBe('<img src=x onerror=alert(1)>');
  });
});
