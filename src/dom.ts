type DomWindow = Window & {
  createEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  createFragment(): DocumentFragment;
};

function hasDomHelpers(window: Window | null): window is DomWindow {
  return window !== null && 'createEl' in window && typeof window.createEl === 'function' &&
    'createFragment' in window && typeof window.createFragment === 'function';
}

export function createEl<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K): HTMLElementTagNameMap[K] {
  const ownerWindow = document.defaultView;
  if (hasDomHelpers(ownerWindow) && ownerWindow.document === document) return ownerWindow.createEl(tag);
  // Importing creates the node in the target document's realm, even without window helpers.
  return document.importNode(window.createEl(tag), false);
}

export function createFragment(document: Document): DocumentFragment {
  const ownerWindow = document.defaultView;
  if (hasDomHelpers(ownerWindow) && ownerWindow.document === document) return ownerWindow.createFragment();
  return document.importNode(window.createFragment(), false);
}
