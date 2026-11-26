const PALETTE = {
  blue: '#356ea6', teal: '#0b8278', green: '#5e7d20', yellow: '#976c00', orange: '#b95b0c',
  rust: '#c45231', red: '#cc4449', pink: '#c0477f', purple: '#9256c6', indigo: '#3e72c5',
};
const COLORS = Object.values(PALETTE);
const NAMED_COLORS: Readonly<Record<string, string>> = {
  ...PALETTE, cyan: PALETTE.teal, black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080',
};
const THEME_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']);

export function randomHippoColor(previous?: string): string {
  const choices = COLORS.filter((color) => color !== previous);
  return choices[Math.floor(Math.random() * choices.length)]!;
}

function rgbChannels(value: string): number[] | undefined {
  const match = /^rgb\(\s*(\d{1,3})(?:\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})|\s+(\d{1,3})\s+(\d{1,3}))\s*\)$/.exec(value);
  if (!match) return;
  const channels = [Number(match[1]), Number(match[2] ?? match[4]), Number(match[3] ?? match[5])];
  if (channels.every((channel) => channel <= 255)) return channels;
}

export function solidHippoColor(value: string | undefined, themed = false): string | undefined {
  if (!value) return;
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, value)) {
    const color = NAMED_COLORS[value]!;
    return themed && THEME_COLORS.has(value) ? `var(--color-${value}, ${color})` : color;
  }
  if (/^#(?:[\da-f]{3}|[\da-f]{6})$/.test(value)) {
    return value.length === 4 ? '#' + [...value.slice(1)].map((digit) => digit + digit).join('') : value;
  }
  const channels = rgbChannels(value);
  if (channels) return '#' + channels.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}

export function hippoSpeechTextColor(color: string): string {
  const hex = solidHippoColor(color);
  if (!hex) return '#fff';
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  return luminance > 0.179 ? '#000' : '#fff';
}
