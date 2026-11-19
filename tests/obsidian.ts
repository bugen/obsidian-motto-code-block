import { StateEffect, StateField } from '@codemirror/state';

if (typeof Node !== 'undefined') {
  Node.prototype.createEl = function (tag) {
    if (!this.ownerDocument) throw new Error('DOM helper requires an owner document.');
    const element = this.ownerDocument.createElement(tag);
    this.appendChild(element);
    return element;
  };
  Node.prototype.createDiv = function () { return this.createEl('div'); };
  Node.prototype.createSpan = function () { return this.createEl('span'); };
  Node.prototype.createSvg = function (tag) {
    if (!this.ownerDocument) throw new Error('DOM helper requires an owner document.');
    const element = this.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag);
    this.appendChild(element);
    return element;
  };
}

export const setLivePreview = StateEffect.define<boolean>();
export const editorLivePreviewField = StateField.define<boolean>({
  create: () => true,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLivePreview)) value = effect.value;
    }
    return value;
  },
});

export class MarkdownRenderChild {
  private readonly cleanups: (() => void)[] = [];
  readonly containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.containerEl = containerEl;
  }

  load(): void {}

  register(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  unload(): void {
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }
}

export function setIcon(element: HTMLElement, icon: string): void {
  const svg = element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('svg-icon');
  svg.setAttribute('data-icon', icon);
  element.replaceChildren(svg);
}

export function setTooltip(element: HTMLElement, tooltip: string): void {
  element.setAttribute('aria-label', tooltip);
}

export async function loadPrism(): Promise<{ highlightElement(element: HTMLElement): void }> {
  return {
    highlightElement(element) {
      if (/\blanguage-(text|txt|plaintext)\b/.test(element.className)) return;
      const token = element.ownerDocument.createElement('span');
      token.className = 'token string';
      token.textContent = element.textContent;
      element.replaceChildren(token);
    },
  };
}

export class App {}
export class Plugin {}
export class TFile {}

export class Notice {
  static messages: string[] = [];

  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export class PluginSettingTab {
  readonly containerEl: HTMLElement;
  // Obsidian's undocumented reference to its settings modal can shadow subclass methods.
  readonly setting = {};

  constructor() {
    this.containerEl = document.createElement('div');
    this.containerEl.empty = () => { this.containerEl.replaceChildren(); };
  }
}

class TextControl {
  readonly inputEl: HTMLInputElement;

  constructor(parent: HTMLElement, type = 'text') {
    this.inputEl = document.createElement('input');
    this.inputEl.type = type;
    parent.append(this.inputEl);
  }

  setValue(value: string): this { this.inputEl.value = value; return this; }
  getValue(): string { return this.inputEl.value; }
  onChange(callback: (value: string) => unknown): this {
    this.inputEl.addEventListener('input', () => { void callback(this.inputEl.value); });
    return this;
  }
}

class TextAreaControl {
  readonly inputEl: HTMLTextAreaElement;

  constructor(parent: HTMLElement) {
    this.inputEl = document.createElement('textarea');
    parent.append(this.inputEl);
  }

  setValue(value: string): this { this.inputEl.value = value; return this; }
  getValue(): string { return this.inputEl.value; }
}

class ToggleControl {
  private readonly inputEl: HTMLInputElement;

  constructor(parent: HTMLElement) {
    this.inputEl = document.createElement('input');
    this.inputEl.type = 'checkbox';
    parent.append(this.inputEl);
  }

  setValue(value: boolean): this { this.inputEl.checked = value; return this; }
  onChange(callback: (value: boolean) => unknown): this {
    this.inputEl.addEventListener('change', () => { void callback(this.inputEl.checked); });
    return this;
  }
}

class DropdownControl {
  private readonly selectEl: HTMLSelectElement;

  constructor(parent: HTMLElement) {
    this.selectEl = document.createElement('select');
    parent.append(this.selectEl);
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, name] of Object.entries(options)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = name;
      this.selectEl.append(option);
    }
    return this;
  }

  setValue(value: string): this { this.selectEl.value = value; return this; }
  onChange(callback: (value: string) => unknown): this {
    this.selectEl.addEventListener('change', () => { void callback(this.selectEl.value); });
    return this;
  }
}

class ExtraButtonControl {
  readonly extraSettingsEl: HTMLButtonElement;

  constructor(parent: HTMLElement) {
    this.extraSettingsEl = document.createElement('button');
    this.extraSettingsEl.type = 'button';
    this.extraSettingsEl.className = 'clickable-icon extra-setting-button';
    parent.append(this.extraSettingsEl);
  }

  setIcon(icon: string): this { setIcon(this.extraSettingsEl, icon); return this; }
  setTooltip(tooltip: string): this {
    this.extraSettingsEl.title = tooltip;
    this.extraSettingsEl.setAttribute('aria-label', tooltip);
    return this;
  }
  onClick(callback: () => unknown): this {
    this.extraSettingsEl.addEventListener('click', () => { void callback(); });
    return this;
  }
}

class ButtonControl {
  readonly buttonEl: HTMLButtonElement;

  constructor(parent: HTMLElement) {
    this.buttonEl = document.createElement('button');
    this.buttonEl.type = 'button';
    parent.append(this.buttonEl);
  }

  setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
  onClick(callback: () => unknown): this {
    this.buttonEl.addEventListener('click', () => { void callback(); });
    return this;
  }
}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;

  constructor(parent: HTMLElement) {
    this.settingEl = document.createElement('div');
    this.settingEl.className = 'setting-item';
    const info = document.createElement('div');
    info.className = 'setting-item-info';
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'setting-item-name';
    this.descEl = document.createElement('div');
    this.descEl.className = 'setting-item-description';
    info.append(this.nameEl, this.descEl);
    this.controlEl = document.createElement('div');
    this.controlEl.className = 'setting-item-control';
    this.settingEl.append(info, this.controlEl);
    parent.append(this.settingEl);
  }

  setName(name: string): this { this.nameEl.textContent = name; return this; }
  setDesc(description: string | DocumentFragment): this { this.descEl.replaceChildren(description); return this; }
  setHeading(): this { this.settingEl.classList.add('setting-item-heading'); return this; }
  setDisabled(disabled: boolean): this {
    this.settingEl.classList.toggle('is-disabled', disabled);
    for (const control of this.controlEl.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >('input, select, textarea, button')) control.disabled = disabled;
    return this;
  }
  addButton(callback: (control: ButtonControl) => void): this {
    callback(new ButtonControl(this.controlEl));
    return this;
  }
  addToggle(callback: (control: ToggleControl) => void): this {
    callback(new ToggleControl(this.controlEl));
    return this;
  }
  addDropdown(callback: (control: DropdownControl) => void): this {
    callback(new DropdownControl(this.controlEl));
    return this;
  }
  addText(callback: (control: TextControl) => void): this {
    callback(new TextControl(this.controlEl));
    return this;
  }
  addTextArea(callback: (control: TextAreaControl) => void): this {
    callback(new TextAreaControl(this.controlEl));
    return this;
  }
  addColorPicker(callback: (control: TextControl) => void): this {
    callback(new TextControl(this.controlEl, 'color'));
    return this;
  }
  addExtraButton(callback: (control: ExtraButtonControl) => void): this {
    callback(new ExtraButtonControl(this.controlEl));
    return this;
  }
}
