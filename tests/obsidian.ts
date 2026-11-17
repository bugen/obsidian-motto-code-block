import { StateEffect, StateField } from '@codemirror/state';

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
  private readonly buttonEl: HTMLButtonElement;

  constructor(parent: HTMLElement) {
    this.buttonEl = document.createElement('button');
    this.buttonEl.type = 'button';
    this.buttonEl.className = 'clickable-icon extra-setting-button';
    parent.append(this.buttonEl);
  }

  setIcon(icon: string): this { setIcon(this.buttonEl, icon); return this; }
  setTooltip(tooltip: string): this {
    this.buttonEl.title = tooltip;
    this.buttonEl.setAttribute('aria-label', tooltip);
    return this;
  }
  onClick(callback: () => unknown): this {
    this.buttonEl.addEventListener('click', () => { void callback(); });
    return this;
  }
}

export class Setting {
  private readonly row: HTMLElement;
  private readonly name: HTMLElement;
  private readonly description: HTMLElement;
  private readonly controls: HTMLElement;

  constructor(parent: HTMLElement) {
    this.row = document.createElement('div');
    this.row.className = 'setting-item';
    const info = document.createElement('div');
    info.className = 'setting-item-info';
    this.name = document.createElement('div');
    this.name.className = 'setting-item-name';
    this.description = document.createElement('div');
    this.description.className = 'setting-item-description';
    info.append(this.name, this.description);
    this.controls = document.createElement('div');
    this.controls.className = 'setting-item-control';
    this.row.append(info, this.controls);
    parent.append(this.row);
  }

  setName(name: string): this { this.name.textContent = name; return this; }
  setDesc(description: string): this { this.description.textContent = description; return this; }
  setHeading(): this { this.row.classList.add('setting-item-heading'); return this; }
  addToggle(callback: (control: ToggleControl) => void): this {
    callback(new ToggleControl(this.controls));
    return this;
  }
  addDropdown(callback: (control: DropdownControl) => void): this {
    callback(new DropdownControl(this.controls));
    return this;
  }
  addText(callback: (control: TextControl) => void): this {
    callback(new TextControl(this.controls));
    return this;
  }
  addTextArea(callback: (control: TextAreaControl) => void): this {
    callback(new TextAreaControl(this.controls));
    return this;
  }
  addColorPicker(callback: (control: TextControl) => void): this {
    callback(new TextControl(this.controls, 'color'));
    return this;
  }
  addExtraButton(callback: (control: ExtraButtonControl) => void): this {
    callback(new ExtraButtonControl(this.controls));
    return this;
  }
}
