import type { HippoFarmOptions } from './codeblock';

export function addFarmHelp(farm: HTMLElement, tools: HTMLElement): void {
  const help = tools.createEl('button');
  help.className = 'motto-command-button';
  help.type = 'button';
  help.textContent = '?';
  help.setAttribute('aria-label', 'Hippo Farm options');
  help.setAttribute('aria-haspopup', 'dialog');

  const dialog = farm.createEl('dialog');
  dialog.className = 'motto-hippo-farm-dialog';
  dialog.setAttribute('aria-label', 'Hippo Farm options');
  const title = dialog.createEl('h2');
  title.textContent = 'Hippo Farm options';
  title.tabIndex = -1;
  title.autofocus = true;
  dialog.createEl('p').textContent = 'Add name=value options after hippo farm on the opening fence. Missing or invalid values use the defaults, and out-of-range numbers are clamped.';
  dialog.createEl('pre').createEl('code').textContent = '```hippo farm hippo_num=18 farm_height=360px\n```';
  const options = dialog.createEl('dl');
  for (const [name, description] of [
    ['hippo_num', '1–30 hippos. Default: 10.'],
    ['hippo_size', '16–96 pixels wide. Default: 46.'],
    ['hippo_speed', '1–5, slowest to fastest. Default: 3.'],
    ['hippo_color', 'random or a solid color. Default: random.'],
    ['farm_height', '120–800 pixels. Default: 240.'],
    ['farm_color', 'A solid color or default to use the theme background.'],
    ['tap_my_hippo', 'true or false. Defaults to the plugin setting.'],
    ['speech_bubble_color', 'same, random, or a solid color. Default: same (matches the hippo).'],
  ] as const) {
    options.createEl('dt').createEl('code').textContent = name;
    options.createEl('dd').textContent = description;
  }
  dialog.createEl('p').textContent = 'Colors: blue, teal, cyan, green, yellow, orange, rust, red, pink, purple, indigo, black, white, and gray (grey); or use #58a, #5588aa, or rgb(85, 136, 170). Farm background colors such as red and blue follow the active theme.';
  const close = dialog.createEl('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  });
  help.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!dialog.open) dialog.showModal();
  });
}

export function sameFarm(a?: HippoFarmOptions, b?: HippoFarmOptions): boolean {
  return a === b || (a !== undefined && b !== undefined &&
    a.count === b.count && a.size === b.size && a.height === b.height && a.speed === b.speed &&
    a.hippoColor === b.hippoColor && a.farmColor === b.farmColor && a.tapMyHippo === b.tapMyHippo &&
    a.speechBubbleColor === b.speechBubbleColor);
}

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function reflect(value: number): number {
  return value < 0 ? -value : value > 100 ? 200 - value : value;
}

export function mountHippoFarm(field: HTMLElement, buttons: HTMLButtonElement[], options: HippoFarmOptions): () => void {
  const document = field.ownerDocument;
  const win = document.defaultView;
  if (!win) throw new Error('[Motto Code Block] Hippos Farm requires a document window.');
  const reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const columns = Math.ceil(Math.sqrt(options.count * 2));
  const rows = Math.ceil(options.count / columns);
  const speedFactor = 1.35 ** (3 - options.speed);
  const herd = buttons.map((button, index) => {
    const row = Math.floor(index / columns);
    const columnsInRow = Math.min(columns, options.count - row * columns);
    return {
      button,
      x: (index % columns + between(0.25, 0.75)) * 100 / columnsInRow,
      y: (row + between(0.3, 0.7)) * 100 / rows,
      timer: undefined as number | undefined,
    };
  });
  type Hippo = (typeof herd)[number];
  const place = ({ button, x, y }: Hippo) => {
    button.style.left = `${x}%`;
    button.style.top = `${y}%`;
  };
  const schedule = (hippo: Hippo, delay: number) => {
    hippo.timer = win.setTimeout(() => {
      if (!field.isConnected || document.hidden || reducedMotion.matches) return;
      const { clientWidth, clientHeight } = field;
      if (clientWidth > 0 && clientHeight > 0) {
        const angle = between(0, 2 * Math.PI);
        const step = Math.min(between(18, 46), clientWidth, clientHeight);
        const nextX = reflect(hippo.x + Math.cos(angle) * step / clientWidth * 100);
        hippo.button.dataset.facing = nextX < hippo.x ? 'left' : 'right';
        hippo.x = nextX;
        hippo.y = reflect(hippo.y + Math.sin(angle) * step / clientHeight * 100);
        const duration = Math.round(between(650, 1050) * speedFactor);
        hippo.button.style.setProperty('--motto-hippo-step-time', `${duration}ms`);
        place(hippo);
        schedule(hippo, duration + between(950, 2800));
      } else {
        schedule(hippo, between(950, 2800));
      }
    }, delay);
  };
  const stop = () => {
    for (const hippo of herd) win.clearTimeout(hippo.timer);
  };
  const syncMotion = () => {
    stop();
    if (!document.hidden && !reducedMotion.matches) {
      for (const hippo of herd) schedule(hippo, between(350, 2400));
    }
  };

  for (const hippo of herd) {
    hippo.button.dataset.facing = Math.random() < 0.5 ? 'left' : 'right';
    place(hippo);
  }
  syncMotion();
  document.addEventListener('visibilitychange', syncMotion);
  reducedMotion.addEventListener('change', syncMotion);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', syncMotion);
    reducedMotion.removeEventListener('change', syncMotion);
  };
}
