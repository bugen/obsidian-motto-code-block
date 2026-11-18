import type { LineNumberMode } from './settings';

export function shouldShowLineNumbers(mode: LineNumberMode, count: number): boolean {
  return count > 0 && (mode === 'always' || (mode === 'default' && count >= 2));
}

export function lineNumberWidth(count: number): string {
  return `${Math.max(2, String(count).length)}ch`;
}

export function createLineNumber(document: Document, number: number): HTMLElement {
  const element = document.createElement('span');
  element.className = 'motto-line-number';
  element.setAttribute('aria-hidden', 'true');
  element.textContent = String(number);
  return element;
}

type CodeLineRect = DOMRect | null | undefined;

function codeLineRects(code: HTMLElement, count: number): CodeLineRect[] {
  const document = code.ownerDocument;
  const text = code.textContent ?? '';
  const range = document.createRange();
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let base = 0;
  let offset = 0;
  return Array.from({ length: count }, () => {
    while (node && offset >= base + (node.textContent?.length ?? 0)) {
      base += node.textContent?.length ?? 0;
      node = walker.nextNode();
    }
    let rect: CodeLineRect = null;
    if (node) {
      const start = Math.min(offset - base, node.textContent?.length ?? 0);
      range.setStart(node, Math.max(0, start));
      range.setEnd(node, Math.min(Math.max(0, start) + 1, node.textContent?.length ?? 0));
      rect = range.getClientRects()[0];
    }
    const newline = text.indexOf('\n', offset);
    offset = newline === -1 ? text.length : newline + 1;
    return rect;
  });
}

export class ReadingCodeLayout {
  private readonly pre: HTMLElement;
  private readonly code: HTMLElement;
  private readonly count: number;
  private readonly previewLines: number | undefined;
  private readonly gutter: HTMLElement | null;
  private readonly resize: ResizeObserver;
  private readonly mutations: MutationObserver;

  constructor(pre: HTMLElement, code: HTMLElement, count: number, numbered: boolean, previewLines?: number) {
    this.pre = pre;
    this.code = code;
    this.count = count;
    this.previewLines = previewLines;
    this.gutter = numbered ? pre.ownerDocument.createElement('span') : null;
    if (this.gutter) {
      this.gutter.className = 'motto-line-numbers';
      this.gutter.setAttribute('aria-hidden', 'true');
      for (let number = 1; number <= (previewLines ?? count); number++) {
        this.gutter.append(createLineNumber(pre.ownerDocument, number));
      }
      pre.classList.add('motto-numbered-codeblock');
      pre.style.setProperty('--motto-line-number-width', lineNumberWidth(count));
      pre.append(this.gutter);
    }
    if (previewLines !== undefined) {
      pre.classList.add('motto-partial-codeblock');
      pre.style.setProperty('--motto-preview-lines', String(previewLines));
    }
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(pre);
    this.resize.observe(code);
    this.mutations = new MutationObserver(() => this.measure());
    this.mutations.observe(code, { childList: true, characterData: true, subtree: true });
    this.measure();
  }

  destroy(): void {
    this.resize.disconnect();
    this.mutations.disconnect();
    this.gutter?.remove();
    this.pre.classList.remove('motto-numbered-codeblock', 'motto-trailing-empty-line', 'motto-partial-codeblock');
    this.pre.style.removeProperty('--motto-line-number-width');
    this.pre.style.removeProperty('--motto-preview-lines');
    this.pre.style.removeProperty('--motto-preview-height');
    this.pre.style.removeProperty('--motto-preview-fade-height');
    this.pre.style.removeProperty('--motto-preview-fade-inset');
  }

  private measure(): void {
    const text = this.code.textContent ?? '';
    this.pre.classList.toggle('motto-trailing-empty-line',
      text.endsWith('\n') && text.split('\n').length === this.count);
    if (this.code.getClientRects().length === 0) return;
    const document = this.pre.ownerDocument;
    const view = document.defaultView;
    if (!view) throw new Error('[Motto Code Block] Cannot measure code layout without a window.');
    const style = view.getComputedStyle(this.code);
    const rects = codeLineRects(this.code, this.previewLines === undefined ? this.count : this.previewLines + 1);
    let previewHeight: string | undefined;
    if (this.previewLines !== undefined) {
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const first = rects[0];
      const hidden = rects[this.previewLines];
      previewHeight = first && hidden
        ? `${hidden.top - first.top + (style.boxSizing === 'border-box' ? padding + border : 0)}px`
        : `calc(${this.code.scrollHeight + (style.boxSizing === 'border-box' ? border : -padding)}px - 1lh)`;
      this.pre.style.setProperty('--motto-preview-fade-height',
        `calc(${Math.min(3, this.previewLines)} * ${style.lineHeight === 'normal' ? '1lh' : style.lineHeight})`);
      this.pre.style.setProperty('--motto-preview-fade-inset', view.getComputedStyle(this.pre).paddingBottom);
    }
    if (this.gutter) this.measureGutter(style, rects);
    if (previewHeight !== undefined) this.pre.style.setProperty('--motto-preview-height', previewHeight);
  }

  private measureGutter(style: CSSStyleDeclaration, rects: CodeLineRect[]): void {
    const gutter = this.gutter;
    if (!gutter) return;
    const document = this.pre.ownerDocument;
    gutter.style.fontFamily = style.fontFamily;
    gutter.style.fontSize = style.fontSize;
    gutter.style.letterSpacing = style.letterSpacing;
    gutter.style.lineHeight = style.lineHeight;
    gutter.style.insetInlineStart = document.defaultView!.getComputedStyle(this.pre).paddingInlineStart;
    const range = document.createRange();
    const first = gutter.firstElementChild;
    if (!first) return;
    range.selectNodeContents(first);
    const labelOffset = range.getBoundingClientRect().top - first.getBoundingClientRect().top;
    const lineHeight = first.getBoundingClientRect().height;
    const top = gutter.getBoundingClientRect().top;
    const codeRect = this.code.getBoundingClientRect();
    const lastLineTop = codeRect.bottom - parseFloat(style.borderBottomWidth) -
      parseFloat(style.paddingBottom) - lineHeight + labelOffset;
    let previousTop = codeRect.top + labelOffset - lineHeight;
    const numbers = [...gutter.querySelectorAll<HTMLElement>(':scope > .motto-line-number')];
    const positions = numbers.map((_, index) => {
      let lineTop = previousTop + lineHeight;
      const rect = rects[index];
      if (rect) lineTop = rect.top;
      else if (rect === null) lineTop = lastLineTop;
      previousTop = lineTop;
      return `${lineTop - top - labelOffset}px`;
    });
    numbers.forEach((number, index) => { number.style.top = positions[index]!; });
  }
}
