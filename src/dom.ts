type DomWindow = Window & {
  createEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  createFragment(): DocumentFragment;
};

function hasDomHelpers(window: Window | null): window is DomWindow {
  return window !== null && 'createEl' in window && typeof window.createEl === 'function' &&
    'createFragment' in window && typeof window.createFragment === 'function';
}

export function createEl<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K): HTMLElementTagNameMap[K] {
  const window = document.defaultView;
  if (hasDomHelpers(window) && window.document === document) return window.createEl(tag);
  // Detached documents and iframe windows need their native document APIs.
  return document.createElement(tag);
}

export function createFragment(document: Document): DocumentFragment {
  const window = document.defaultView;
  if (hasDomHelpers(window) && window.document === document) return window.createFragment();
  return document.createDocumentFragment();
}
