import { hippoSpeechTextColor, randomHippoColor } from './hippo-colors';
import type { MottoSettings } from './settings';

const REPLIES = [
  'You rang?',
  'Ah. There it is.',
  'Well, that surfaced.',
  'A little less mystery.',
  'The plot thickens.',
  'The river has footnotes.',
  'The depths say hello.',
  'Even silence has layers.',
  'Nothing up my sleeves.',
  'A ripple was inevitable.',
] as const;
const speeches = new WeakMap<HTMLButtonElement, HippoSpeech>();

interface OutputToggle {
  open: boolean;
  styles: MottoSettings['outputToggleStyles'];
}

interface FarmSpeech {
  color: string;
}

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

class HippoSpeech {
  private readonly button: HTMLButtonElement;
  private readonly window: NonNullable<Document['defaultView']>;
  private readonly observer: MutationObserver | undefined;
  private readonly scale: number;
  private readonly farm: FarmSpeech | undefined;
  private output: OutputToggle | undefined;
  private shown = false;
  private disposed = false;
  private nextTimer: number | undefined;
  private hideTimer: number | undefined;
  private frame: number | undefined;
  private bubble: HTMLDivElement | undefined;
  private phase: 'prompt' | 'response' | undefined;

  constructor(button: HTMLButtonElement, output: OutputToggle | undefined, farm: FarmSpeech | undefined) {
    const window = button.ownerDocument.defaultView;
    if (!window) throw new Error('[Motto Code Block] Hippo speech requires a document window.');
    this.button = button;
    this.window = window;
    this.output = output;
    this.farm = farm;
    this.scale = output || farm ? 1 : 3;
    if (output) {
      this.observer = new window.MutationObserver(this.sync);
      this.observer.observe(button.ownerDocument.body, { attributes: true, attributeFilter: ['class'] });
    }
    button.ownerDocument.addEventListener('visibilitychange', this.sync);
    this.sync();
  }

  update(output: OutputToggle | undefined): void {
    this.output = output;
    this.sync();
  }

  reply(): void {
    if (!this.available() || this.output?.open) return;
    if (this.phase !== 'prompt') {
      if (this.bubble && this.farm?.color === 'same') this.setBubbleColor(this.bubble);
      return;
    }
    this.cancelNext();
    this.show(REPLIES[randomBetween(0, REPLIES.length - 1)]!, 'response');
  }

  destroy(): void {
    this.disposed = true;
    this.cancelNext();
    this.hide();
    this.observer?.disconnect();
    this.button.ownerDocument.removeEventListener('visibilitychange', this.sync);
  }

  private available(): boolean {
    const document = this.button.ownerDocument;
    if (this.disposed || document.hidden) return false;
    if (!this.output) return true;
    const mode = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    return this.output.styles[mode].icon === 'hippo';
  }

  private readonly sync = (): void => {
    if (!this.available()) {
      this.cancelNext();
      this.hide();
    } else if (this.output?.open) {
      this.cancelNext();
      // The reply deliberately outlives the click that opens the output.
      if (this.phase !== 'response') this.hide();
    } else if (this.nextTimer === undefined && this.phase !== 'response') {
      this.schedule();
    }
  };

  private schedule(): void {
    const delay = this.shown ? randomBetween(60_000, 180_000) : randomBetween(5_000, 60_000);
    this.nextTimer = this.window.setTimeout(() => {
      this.nextTimer = undefined;
      if (!this.button.isConnected) { this.destroy(); return; }
      if (this.available() && !this.output?.open) this.show(this.farm ? 'Tap to hip-po!' : 'Tap my hip-po!', 'prompt');
      this.sync();
    }, delay);
  }

  private cancelNext(): void {
    this.window.clearTimeout(this.nextTimer);
    this.nextTimer = undefined;
  }

  private anchor(): DOMRect | undefined {
    const button = this.button;
    if (!button.isConnected || button.closest('[hidden]')) return;
    const rect = button.getBoundingClientRect();
    const style = this.window.getComputedStyle(button);
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 ||
        rect.top >= this.window.innerHeight || rect.left >= this.window.innerWidth ||
        style.visibility === 'hidden' || style.display === 'none') return;
    return rect;
  }

  private show(text: string, phase: 'prompt' | 'response'): void {
    if (!this.anchor()) return;
    if (this.farm && phase === 'prompt' &&
        this.button.parentElement?.querySelector('[data-motto-hippo-speaking]')) return;
    this.window.clearTimeout(this.hideTimer);
    if (!this.bubble) {
      this.bubble = this.button.ownerDocument.body.createDiv();
      this.bubble.className = 'motto-hippo-speech';
      this.bubble.dataset.motion = 'enter';
      this.bubble.setAttribute('aria-hidden', 'true');
      this.bubble.style.setProperty('--motto-hippo-speech-scale', String(this.scale));
    } else if (this.bubble.dataset.motion === 'exit') this.bubble.dataset.motion = 'idle';
    this.shown = true;
    this.phase = phase;
    if (this.farm) this.button.dataset.mottoHippoSpeaking = '';
    this.bubble.dataset.phase = phase;
    this.bubble.textContent = text;
    this.setBubbleColor(this.bubble);
    if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
    this.position();
    this.hideTimer = this.window.setTimeout(() => {
      if (this.bubble) this.bubble.dataset.motion = 'exit';
      this.hideTimer = this.window.setTimeout(() => {
        this.hide();
        this.sync();
      }, 100);
    }, 3_900);
  }

  private setBubbleColor(bubble: HTMLDivElement): void {
    const choice = this.farm?.color ?? 'random';
    const color = choice === 'random' ? randomHippoColor() : choice === 'same' ? this.button.style.color : choice;
    bubble.style.setProperty('--motto-hippo-bubble-color', color);
    if (choice !== 'random') bubble.style.color = hippoSpeechTextColor(color);
  }

  private readonly position = (): void => {
    const bubble = this.bubble;
    if (!bubble) return;
    const anchor = this.anchor();
    if (!anchor) { this.hide(); this.sync(); return; }
    // Measure the unscaled box so the animation cannot shift its anchor.
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const center = anchor.left + anchor.width / 2;
    const left = Math.max(8, Math.min(center - width / 2, this.window.innerWidth - width - 8));
    const gap = 6 * this.scale + 4;
    const aboveSpace = anchor.top - gap - 6;
    const belowSpace = this.window.innerHeight - anchor.bottom - gap - 6;
    const below = aboveSpace < height && (this.scale === 1 || belowSpace >= aboveSpace);
    const top = below ? anchor.bottom + gap : anchor.top - height - gap;
    const tailEdge = Math.max(8, gap - 2);
    const minTop = below ? tailEdge : 8;
    const maxTop = this.window.innerHeight - height - (below ? 8 : tailEdge);
    const tailInset = Math.min(12 * this.scale, width / 2);
    bubble.dataset.side = below ? 'below' : 'above';
    bubble.style.left = `${left}px`;
    bubble.style.top = `${Math.max(minTop, Math.min(top, maxTop))}px`;
    bubble.style.setProperty('--motto-hippo-tail-left', `${Math.max(tailInset, Math.min(center - left, width - tailInset))}px`);
    this.frame = this.window.requestAnimationFrame(this.position);
  };

  private hide(): void {
    this.window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.bubble?.remove();
    this.bubble = undefined;
    this.phase = undefined;
    if (this.farm) delete this.button.dataset.mottoHippoSpeaking;
  }
}

export function updateHippoSpeech(button: HTMLButtonElement, enabled: boolean, target?: OutputToggle | FarmSpeech): void {
  const output = target && 'styles' in target ? target : undefined;
  const existing = speeches.get(button);
  if (!enabled || (output && output.styles.light.icon !== 'hippo' && output.styles.dark.icon !== 'hippo')) {
    existing?.destroy();
    speeches.delete(button);
  } else if (existing) existing.update(output);
  else speeches.set(button, new HippoSpeech(button, output, target && 'color' in target ? target : undefined));
}

export function replyToHippo(button: HTMLButtonElement): void {
  speeches.get(button)?.reply();
}

export function destroyHippoSpeech(container: HTMLElement): void {
  for (const button of container.querySelectorAll<HTMLButtonElement>('.motto-output-toggle')) {
    speeches.get(button)?.destroy();
    speeches.delete(button);
  }
}
