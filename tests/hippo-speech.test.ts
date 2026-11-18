// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandTools, setOutputToggle } from '../src/command-render';
import { destroyHippoSpeech } from '../src/hippo-speech';
import { parseSettings, type MottoSettings } from '../src/settings';

const roots: HTMLElement[] = [];
const stylesheet = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');

function fixture(initial: Partial<MottoSettings> = {}, initiallyOpen = false) {
  let settings = parseSettings({
    tapMyHippo: true,
    outputToggleStyles: { light: { icon: 'hippo' }, dark: { icon: 'hippo' } },
    ...initial,
  });
  let open = initiallyOpen;
  const toggle = vi.fn(() => {
    open = !open;
    setOutputToggle(button, open, settings.outputToggleStyles, settings.tapMyHippo);
  });
  const tools = commandTools(document, 'pwd', open, settings.outputToggleStyles, toggle, settings.tapMyHippo);
  const button = tools.querySelector<HTMLButtonElement>('.motto-output-toggle')!;
  const rect = vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(300, 200, 32, 24));
  document.body.append(tools);
  roots.push(tools);
  return {
    tools, button, toggle, rect,
    setOpen(value: boolean) {
      open = value;
      setOutputToggle(button, open, settings.outputToggleStyles, settings.tapMyHippo);
    },
    update(patch: Partial<MottoSettings>) {
      settings = parseSettings({ ...settings, ...patch });
      setOutputToggle(button, open, settings.outputToggleStyles, settings.tapMyHippo);
    },
  };
}

function bubble(): HTMLDivElement | null {
  return document.querySelector('.motto-hippo-speech');
}

afterEach(() => {
  for (const root of roots.splice(0)) destroyHippoSpeech(root);
  document.body.replaceChildren();
  document.body.className = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Hippo speech bubbles', () => {
  it.each([
    [0, 5_000, 60_000],
    [0.999999, 60_000, 180_000],
  ])('uses random boundary %s for the first and recurring invitations', async (random, first, repeat) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(random);
    const { button } = fixture();
    await vi.advanceTimersByTimeAsync(first - 1);
    expect(bubble()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(bubble()?.textContent).toBe('Tap my hip-po!');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(bubble()?.parentElement).toBe(document.body);
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      await vi.advanceTimersByTimeAsync(3_999);
      expect(bubble()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(bubble()).toBeNull();
      await vi.advanceTimersByTimeAsync(repeat - 4_001);
      expect(bubble()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(bubble()?.textContent).toBe('Tap my hip-po!');
    }
  });

  it('only replies to an invitation click, preserves toggling and hides the reply after four seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { button, toggle, tools } = fixture();
    const parentClick = vi.fn();
    tools.addEventListener('click', parentClick);
    button.click();
    expect(bubble()).toBeNull();
    button.click();
    await vi.advanceTimersByTimeAsync(5_000);
    button.click();
    expect(toggle).toHaveBeenCalledTimes(3);
    expect(parentClick).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(bubble()?.textContent).toBe('You rang?');
    expect(bubble()?.dataset.phase).toBe('response');
    await vi.advanceTimersByTimeAsync(3_999);
    expect(bubble()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(bubble()).toBeNull();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(bubble()).toBeNull();
  });

  it('renders ten distinct replies and solid colors with white-text contrast of at least 4.5:1', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const { button, setOpen } = fixture();
    const style = document.createElement('style');
    style.textContent = stylesheet;
    document.body.append(style);
    const colors = new Set<string>();
    const replies = new Set<string>();
    await vi.advanceTimersByTimeAsync(5_000);
    for (let index = 0; index < 10; index++) {
      random.mockReturnValue((index + 0.1) / 10);
      button.click();
      const current = bubble()!;
      const color = current.style.getPropertyValue('--motto-hippo-bubble-color');
      colors.add(color);
      replies.add(current.textContent!);
      expect(['#fff', 'rgb(255, 255, 255)']).toContain(getComputedStyle(current).color);
      const channels = [1, 3, 5].map((offset) => {
        const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
      setOpen(false);
      random.mockReturnValue(0);
      await vi.advanceTimersByTimeAsync(64_000);
      expect(bubble()?.dataset.phase).toBe('prompt');
    }
    expect(colors.size).toBe(10);
    expect(replies.size).toBe(10);
  });

  it.each([false, true])('does not invite with the feature disabled (output open: %s)', async (open) => {
    vi.useFakeTimers();
    fixture({ tapMyHippo: false }, open);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(bubble()).toBeNull();
  });

  it('tracks the active theme rather than the inactive Hippo icon or reversed artwork', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fixture({
      outputToggleStyles: parseSettings({
        outputToggleStyles: { light: { icon: 'eye' }, dark: { icon: 'hippo', reverseIcons: true } },
      }).outputToggleStyles,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bubble()).toBeNull();
    document.body.className = 'theme-dark';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bubble()?.textContent).toBe('Tap my hip-po!');
    document.body.className = 'theme-light';
    await vi.advanceTimersByTimeAsync(0);
    expect(bubble()).toBeNull();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(bubble()).toBeNull();
  });

  it('dismisses invitations when opening output otherwise, and stops when disabled or icons change', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { button, setOpen, update } = fixture({}, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bubble()).toBeNull();
    setOpen(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bubble()).not.toBeNull();
    setOpen(true);
    expect(bubble()).toBeNull();
    setOpen(false);
    await vi.advanceTimersByTimeAsync(60_000);
    button.click();
    expect(bubble()?.dataset.phase).toBe('response');
    update({ tapMyHippo: false });
    expect(bubble()).toBeNull();
    setOpen(false);
    update({ tapMyHippo: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bubble()).not.toBeNull();
    update({ outputToggleStyles: parseSettings(null).outputToggleStyles });
    expect(bubble()).toBeNull();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(bubble()).toBeNull();
  });

  it('pauses in hidden documents and does not display for hidden or offscreen anchors', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { tools, rect } = fixture();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bubble()).toBeNull();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    tools.hidden = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bubble()).toBeNull();
    tools.hidden = false;
    rect.mockReturnValue(new DOMRect(-100, -100, 32, 24));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bubble()).toBeNull();
    rect.mockReturnValue(new DOMRect(300, 200, 32, 24));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bubble()).not.toBeNull();
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(bubble()).toBeNull();
  });

  it('follows layout shifts while visible, including output opened above another Hippo', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { rect } = fixture();
    await vi.advanceTimersByTimeAsync(5_000);
    const top = Number.parseFloat(bubble()!.style.top);
    rect.mockReturnValue(new DOMRect(300, 300, 32, 24));
    await vi.advanceTimersByTimeAsync(32);
    expect(Number.parseFloat(bubble()!.style.top) - top).toBe(100);
  });

  it('uses the unscaled size to keep the placement fixed while the bubble grows', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fixture();
    await vi.advanceTimersByTimeAsync(5_000);
    const current = bubble()!;
    vi.spyOn(current, 'offsetWidth', 'get').mockReturnValue(120);
    vi.spyOn(current, 'offsetHeight', 'get').mockReturnValue(34);
    const rect = vi.spyOn(current, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 105.6, 29.92));
    await vi.advanceTimersByTimeAsync(32);
    expect([current.style.left, current.style.top]).toEqual(['256px', '156px']);
    rect.mockReturnValue(new DOMRect(0, 0, 120, 34));
    await vi.advanceTimersByTimeAsync(160);
    expect([current.style.left, current.style.top]).toEqual(['256px', '156px']);
  });

  it('uses the final 100ms for exit and lets a click replace a fading invitation without reinflating', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { button } = fixture();
    await vi.advanceTimersByTimeAsync(5_000);
    const current = bubble()!;
    expect(current.dataset.motion).toBe('enter');
    await vi.advanceTimersByTimeAsync(3_899);
    expect(current.dataset.motion).toBe('enter');
    await vi.advanceTimersByTimeAsync(1);
    expect(current.dataset.motion).toBe('exit');
    button.click();
    expect(bubble()).toBe(current);
    expect(current.dataset.motion).toBe('idle');
    expect(current.textContent).toBe('You rang?');
    await vi.advanceTimersByTimeAsync(3_900);
    expect(current.dataset.motion).toBe('exit');
    await vi.advanceTimersByTimeAsync(99);
    expect(bubble()).toBe(current);
    await vi.advanceTimersByTimeAsync(1);
    expect(bubble()).toBeNull();
  });

  it.each(['pending', 'prompt', 'response', 'exit'])('cleans up timers and overlays when destroyed during %s', async (phase) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { tools, button } = fixture();
    if (phase !== 'pending') await vi.advanceTimersByTimeAsync(5_000);
    if (phase === 'response') button.click();
    if (phase === 'exit') await vi.advanceTimersByTimeAsync(3_900);
    destroyHippoSpeech(tools);
    expect(bubble()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(bubble()).toBeNull();
  });
});
