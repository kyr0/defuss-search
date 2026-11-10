/**
 * The code colours of the site: Shiki's github-light and github-dark, with every token colour that falls under
 * WCAG AA (4.5:1) on the site's code surfaces moved toward black or white until it passes.
 * VERIFIED: axe-core (2026-11-09) measured github-dark's comments at 3.95:1 on the dark code blocks. scripts/highlight.mjs (build time)
 * and website/highlight-runtime.mjs (the playground) both use these, so the two never disagree.
 */
import githubDark from '@shikijs/themes/github-dark';
import githubLight from '@shikijs/themes/github-light';

const AA = 4.6; // 4.5 with a margin for rounding in the browser's colour pipeline
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linear = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
export const contrast = (a, b) => {
  const [x, y] = [luminance(channels(a)), luminance(channels(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const hex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** `color` (#rrggbb or #rrggbbaa), mixed toward `toward` in 4% steps until it reaches AA on `surface`. */
function readable(color, surface, toward) {
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) return color;
  const alpha = color.slice(7);
  let rgb = channels(color);
  const target = channels(toward);
  for (let step = 0; step < 25 && contrast(hex(rgb), surface) < AA; step++)
    rgb = rgb.map((c, i) => c + (target[i] - c) * 0.04 * (step + 1));
  return hex(rgb) + alpha;
}

function adjust(theme, name, surface, toward) {
  const copy = structuredClone(theme);
  copy.name = name;
  for (const rule of copy.tokenColors ?? [])
    if (rule.settings?.foreground) rule.settings.foreground = readable(rule.settings.foreground, surface, toward);
  if (copy.colors?.['editor.foreground'])
    copy.colors['editor.foreground'] = readable(copy.colors['editor.foreground'], surface, toward);
  return copy;
}

/** The lightest dark code surface (the playground console) and the darkest light one (the playground editor). */
export const SURFACES = { dark: '#1c1c20', light: '#f2f2f2' };
export const LIGHT = adjust(githubLight, 'github-light-aa', SURFACES.light, '#000000');
export const DARK = adjust(githubDark, 'github-dark-aa', SURFACES.dark, '#ffffff');
export const THEMES = { light: LIGHT.name, dark: DARK.name };
