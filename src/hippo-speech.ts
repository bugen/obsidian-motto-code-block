import type { MottoSettings } from './settings';

const COLORS = [
  '#356ea6', '#0b8278', '#5e7d20', '#976c00', '#b95b0c',
  '#c45231', '#cc4449', '#c0477f', '#9256c6', '#3e72c5',
] as const;
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

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

class HippoSpeech {
  private readonly button: HTMLButtonElement;
  private readonly window: Window & typeof globalThis;
  private readonly observer: MutationObserver;
  private styles: MottoSettings['outputToggleStyles'];
  private open: boolean;
  private shown = false;
  private disposed = false;
  private nextTimer: number | undefined;
  private hideTimer: number | undefined;
  private frame: number | undefined;
  private bubble: HTMLDivElement | undefined;
  private phase: 'prompt' | 'response' | undefined;

  constructor(button: HTMLButtonElement, open: boolean, styles: MottoSettings['outputToggleStyles']) {
    const window = button.ownerDocument.defaultView;
    if (!window) throw new Error('[Motto Code Block] Hippo speech requires a document window.');
    this.button = button;
    this.window = window;
    this.open = open;
    this.styles = styles;
    this.observer = new window.MutationObserver(this.sync);
    this.observer.observe(button.ownerDocument.body, { attributes: true, attributeFilter: ['class'] });
    button.ownerDocument.addEventListener('visibilitychange', this.sync);
    this.sync();
  }

  update(open: boolean, styles: MottoSettings['outputToggleStyles']): void {
    this.open = open;
    this.styles = styles;
    this.sync();
  }

  reply(): void {
    if (this.phase !== 'prompt' || !this.available() || this.open) return;
    this.cancelNext();
    this.show(REPLIES[randomBetween(0, REPLIES.length - 1)]!, 'response');
  }

  destroy(): void {
    this.disposed = true;
    this.cancelNext();
    this.hide();
    this.observer.disconnect();
    this.button.ownerDocument.removeEventListener('visibilitychange', this.sync);
  }

  private available(): boolean {
    const document = this.button.ownerDocument;
    const mode = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    return !this.disposed && !document.hidden && this.styles[mode].icon === 'hippo';
  }

  private readonly sync = (): void => {
    if (!this.available()) {
      this.cancelNext();
      this.hide();
    } else if (this.open) {
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
      if (this.available() && !this.open) this.show('Tap my hip-po!', 'prompt');
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
    this.window.clearTimeout(this.hideTimer);
    if (!this.bubble) {
      this.bubble = this.button.ownerDocument.createElement('div');
      this.bubble.className = 'motto-hippo-speech';
      this.bubble.dataset.motion = 'enter';
      this.bubble.setAttribute('aria-hidden', 'true');
      this.button.ownerDocument.body.append(this.bubble);
    } else if (this.bubble.dataset.motion === 'exit') this.bubble.dataset.motion = 'idle';
    this.shown = true;
    this.phase = phase;
    this.bubble.dataset.phase = phase;
    this.bubble.textContent = text;
    this.bubble.style.setProperty('--motto-hippo-bubble-color', COLORS[randomBetween(0, COLORS.length - 1)]!);
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
    const below = anchor.top < height + 16;
    const top = below ? anchor.bottom + 10 : anchor.top - height - 10;
    bubble.dataset.side = below ? 'below' : 'above';
    bubble.style.left = `${left}px`;
    bubble.style.top = `${Math.max(8, Math.min(top, this.window.innerHeight - height - 8))}px`;
    bubble.style.setProperty('--motto-hippo-tail-left', `${Math.max(12, Math.min(center - left, width - 12))}px`);
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
  }
}

export function updateHippoSpeech(
  button: HTMLButtonElement, open: boolean, styles: MottoSettings['outputToggleStyles'], enabled: boolean,
): void {
  const existing = speeches.get(button);
  if (!enabled || (styles.light.icon !== 'hippo' && styles.dark.icon !== 'hippo')) {
    existing?.destroy();
    speeches.delete(button);
  } else if (existing) existing.update(open, styles);
  else speeches.set(button, new HippoSpeech(button, open, styles));
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
