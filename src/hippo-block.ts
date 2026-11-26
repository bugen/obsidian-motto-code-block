import { Notice, type Editor } from 'obsidian';
import { frontmatterEnd, parseCodeBlocks, type HippoFarmOptions } from './codeblock';
import { terminalDeleteButton, terminalEditButton } from './command-render';
import { createEl } from './dom';
import { randomHippoColor } from './hippo-colors';
import { addFarmHelp, mountHippoFarm } from './hippo-farm';
import { replyToHippo, updateHippoSpeech } from './hippo-speech';
import hippoIcon from './hippo.svg';
import { padMarkdownBlock } from './markdown-insert';

const HIPPO_FALLBACK = [
  'Sorry... To see this block, open this note in Obsidian with the Motto Code Block plugin installed.',
  'https://github.com/bugen/obsidian-motto-code-block',
].join('\n');

export function insertHippo(editor: Editor, kind: 'big' | 'farm'): void {
  const markdown = [`\`\`\`hippo ${kind}`, HIPPO_FALLBACK, '```'].join('\n');
  const cursor = editor.getCursor();
  const source = editor.getValue();
  const offset = editor.posToOffset(cursor);
  const text = padMarkdownBlock(editor, markdown, cursor);
  const proposed = source.slice(0, offset) + text + source.slice(offset);
  const from = offset + text.indexOf(markdown);
  if (offset < frontmatterEnd(source) ||
      !parseCodeBlocks(proposed).blocks.some((block) => block.from === from && (kind === 'big' ? block.hippoBig : block.hippoFarm))) {
    const name = kind === 'big' ? 'Big Hippo' : 'Hippo Farm';
    new Notice(`Motto Code Block: Move the cursor outside code blocks or note properties to insert ${name}.`);
    return;
  }
  editor.transaction({
    changes: [{ from: cursor, text }],
    selection: { from: { line: cursor.line + text.split('\n').length - 1, ch: 0 } },
  });
}

export class HippoBlockView {
  readonly element: HTMLDivElement;
  readonly farm: HippoFarmOptions | undefined;
  private readonly buttons: HTMLButtonElement[];
  private readonly unmountFarm: (() => void) | undefined;

  constructor(document: Document, farm?: HippoFarmOptions, actions?: { edit: () => void; remove: () => void }) {
    const element = this.element = createEl(document, 'div');
    element.className = 'motto-hippo-block';
    this.farm = farm;
    if (farm) {
      element.classList.add('motto-hippo-farm');
      element.style.height = `${farm.height}px`;
      element.style.setProperty('--motto-farm-hippo-size', `${farm.size}px`);
      if (farm.farmColor !== 'default') element.style.setProperty('--motto-farm-color', farm.farmColor);
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', 'Hippos Farm');
      const field = element.createDiv();
      field.className = 'motto-hippo-field';
      this.buttons = Array.from({ length: farm.count }, (_, index) =>
        this.createHippo(field, `Hippo ${index + 1}: Tap to hip-po!`));
      this.unmountFarm = mountHippoFarm(field, this.buttons, farm);
    } else {
      this.buttons = [this.createHippo(element, 'Tap to hip-po!')];
    }
    if (farm || actions) {
      const tools = element.createDiv();
      tools.className = 'motto-hippo-tools';
      if (farm) addFarmHelp(element, tools);
      if (actions) {
        tools.append(
          terminalEditButton(document, 'Edit Hippo block', actions.edit),
          terminalDeleteButton(document, 'Delete Hippo block', actions.remove),
        );
      }
    }
  }

  private createHippo(parent: HTMLElement, label: string): HTMLButtonElement {
    const button = parent.createEl('button');
    button.className = 'motto-hippo-tap';
    button.type = 'button';
    button.setAttribute('aria-label', label);
    const mark = button.createSpan();
    mark.className = 'motto-hippo-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.style.maskImage = `url(${JSON.stringify(hippoIcon)})`;
    const colorTarget = this.farm ? button : mark;
    const fixed = this.farm?.hippoColor;
    const random = fixed === undefined || fixed === 'random';
    let color = random ? randomHippoColor() : fixed;
    colorTarget.style.color = color;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (random) {
        color = randomHippoColor(color);
        colorTarget.style.color = color;
      }
      replyToHippo(button);
    });
    return button;
  }

  setSpeech(enabled: boolean): void {
    const farm = this.farm;
    for (const button of this.buttons) {
      updateHippoSpeech(button, farm?.tapMyHippo ?? enabled, farm ? { color: farm.speechBubbleColor } : undefined);
    }
  }

  dispose(): void {
    this.unmountFarm?.();
    for (const button of this.buttons) updateHippoSpeech(button, false);
  }

  destroy(): void {
    this.dispose();
    this.element.remove();
  }
}
