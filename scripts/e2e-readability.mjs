/**
 * Readability of the built page in one theme and viewport (scripts/e2e-site.mjs runs it in light and dark, on a
 * desktop and a phone):
 * - size: no visible text under 12px, and running text (60 characters or more) at least 14px; below the desktop
 *   layout the page shows at 75% (website/site.css), and the floors are the platforms' own minimums, 11px (Apple's
 *   Human Interface Guidelines and Material Design's smallest label) and 13px, Apple's footnote, for running text;
 * - layout: no control or text block runs past the viewport's edge, unless a horizontal scroller holds it;
 * - axe-core's WCAG 2.2 A and AA rules, colour contrast included, report no violation;
 * - text axe cannot measure, because it sits on the hero's shader, a surface pattern, a gradient or a translucent
 *   layer, is measured from pixels: a screenshot of the page with all text hidden gives the real background under
 *   each element, and the text colour must reach 4.5:1 (3:1 for large text, 24px or 18.7px bold) against the
 *   background pixels inside the box (less a pill's rounded ends); the worst 5% of them, borders and antialiasing,
 *   are left out.
 * Why pixels: the shader is WebGL and the surfaces are layered CSS, so no computed style names the colour behind
 * the text; only the rendered page does.
 * VERIFIED: make e2e passes it in English, light and dark, on a desktop and a phone, and in German (2026-11-09).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const AXE = await readFile('node_modules/axe-core/axe.min.js', 'utf8');
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// No animation: every element shows its resting style, including sections revealed by scroll (a zero duration
// leaves a scroll-driven reveal at its hidden start); a rotator shows its first line, the fly-through its first word.
const SETTLE = `
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .text-rotate > span > * { opacity: 0 !important; }
  .text-rotate > span > :first-child { opacity: 1 !important; }
  .hs-flythrough .parallax-layer:has(.hs-fly-word) ~ .parallax-layer:has(.hs-fly-word) { visibility: hidden !important; }`;
const HIDE_TEXT = `
  html.hs-audit * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }
  html.hs-audit :is(.hs-grad, .hs-usp-value, .hs-fly-word, .hs-shine) { background: none !important; }
  html.hs-audit .hs-flip { filter: none !important; }
  html.hs-audit svg text { fill: transparent !important; }
  html.hs-audit .mk-header, html.hs-audit .fab { visibility: hidden !important; }
  html.hs-audit.hs-audit-header .mk-header { visibility: visible !important; }`;

export async function checkReadability(page, label, { min = 12, running = 14 } = {}) {
  // Bring every lazy part in: scroll the page through, let the charts and entrances finish.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 600) {
    await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), y);
    await page.waitForTimeout(60);
  }
  await page.waitForFunction(() => window.chartsReady, {}, { timeout: 30000 });
  await page.evaluate((css) => {
    for (const item of document.querySelectorAll('[data-enter]')) item.dataset.dfEntrance = item.dataset.enter;
    // A playing diagram changes its parts between the screenshot and the measurement; shown whole, it holds still.
    for (const button of document.querySelectorAll('.diagram-controls [data-action="all"]')) button.click();
    const style = document.createElement('style');
    style.id = 'hs-audit-style';
    style.textContent = css;
    document.head.append(style);
  }, SETTLE + HIDE_TEXT);
  await page.waitForTimeout(300);

  // ---- size --------------------------------------------------------------------------------------------------
  const small = await page.evaluate(({ min, running }) => {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      const el = node.parentElement;
      if (!text || el.closest('template, script, style, .sr-only, [hidden], dialog:not([open])')) continue;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!box.width || !box.height || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const size = parseFloat(style.fontSize);
      const sentence = el.closest('p, li, td, figcaption')?.textContent.trim().length >= 60;
      if (size < min || (sentence && size < running && !el.closest('code, kbd, pre, .badge, .mockup-code, .mk-code-block, table')))
        found.push(`${size}px "${text.slice(0, 40)}" in <${el.localName} class="${el.className}">`);
    }
    return found;
  }, { min, running });
  assert.deepEqual(small, [], `${label}: text too small`);

  // ---- nothing cut off: controls and text stay inside the viewport, unless a scroller holds them ---------------
  const outside = await page.evaluate(() => {
    const scrolls = (el) => {
      for (let up = el.parentElement; up; up = up.parentElement) {
        const x = getComputedStyle(up).overflowX;
        if ((x === 'auto' || x === 'scroll') && up.scrollWidth > up.clientWidth) return true;
      }
      return false;
    };
    return [...document.querySelectorAll('main :is(button, a.btn, .badge, h1, h2, h3, p, li, label), .mk-header :is(a, button), .mk-footer :is(a, p)')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        if (!box.width || el.closest('.sr-only, [hidden], dialog:not([open]), .parallax, svg') || scrolls(el)) return false;
        return box.left < -1 || box.right > innerWidth + 1;
      })
      .map((el) => `<${el.localName}> "${el.textContent.trim().slice(0, 40)}"`);
  });
  assert.deepEqual(outside, [], `${label}: cut off at the viewport edge`);

  // ---- axe: WCAG A and AA ------------------------------------------------------------------------------------
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(
    (tags) => axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] }),
    WCAG,
  );
  const violations = result.violations.flatMap((rule) =>
    rule.nodes.map((node) => `${rule.id}: ${node.target.join(' ')}: ${node.failureSummary.replace(/\s+/g, ' ')}`),
  );
  assert.deepEqual(violations, [], `${label}: axe-core WCAG 2.2 AA`);

  // ---- pixels: the text axe could not measure ----------------------------------------------------------------
  const targets = (result.incomplete.find((rule) => rule.id === 'color-contrast')?.nodes ?? []).map((node) => node.target[0]);
  const items = await page.evaluate((selectors) => {
    const canvas = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    const rgba = (color) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data];
    };
    return selectors.flatMap((selector) => {
      const el = document.querySelector(selector);
      if (!el || el.closest('svg')) return [];
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || style.visibility === 'hidden' || Number(style.opacity) === 0) return [];
      // Gradient text shows its stops; plain text its colour.
      const grad = el.closest('.hs-grad, .hs-usp-value');
      const root = getComputedStyle(document.documentElement);
      const colors = grad
        ? ['--hs-lexical', '--hs-vector'].map((name) => rgba(root.getPropertyValue(name)))
        : [rgba(style.color)];
      // A textarea under a painted layer shows no text of its own (the editor's colours are Shiki's AA themes).
      if (colors.every((color) => color[3] === 0)) return [];
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      return [{
        selector,
        text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 50),
        top: box.top + scrollY,
        header: !!el.closest('.mk-header'),
        colors,
        need: large ? 3 : 4.5,
      }];
    });
  }, targets);
  const failures = [];
  let worst = Infinity;
  const measure = async (group, scroll, header) => {
    await page.evaluate(([y, header]) => {
      scrollTo({ top: y, behavior: 'instant' });
      document.documentElement.classList.add('hs-audit');
      document.documentElement.classList.toggle('hs-audit-header', header);
    }, [scroll, header]);
    await page.waitForTimeout(80);
    const png = (await page.screenshot({ type: 'png' })).toString('base64');
    const ratios = await page.evaluate(async ([png, group]) => {
      document.documentElement.classList.remove('hs-audit', 'hs-audit-header');
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const linear = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
      const ratio = (a, b) => {
        const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      return group.map((item) => {
        // The inner part of the box: a pill's rounded ends show the page behind it, not the colour under the text.
        const box = document.querySelector(item.selector).getBoundingClientRect();
        const insetX = Math.min(box.height / 2, box.width / 4);
        const insetY = box.height * 0.15;
        const x = Math.max(0, Math.floor(box.left + insetX));
        const y = Math.max(0, Math.floor(box.top + insetY));
        const w = Math.min(bitmap.width - x, Math.ceil(box.width - 2 * insetX));
        const h = Math.min(bitmap.height - y, Math.ceil(box.height - 2 * insetY));
        if (w < 1 || h < 1) return null;
        const data = context.getImageData(x, y, w, h).data;
        const per = [];
        for (let i = 0; i < data.length; i += 4 * 3) {
          const background = [data[i], data[i + 1], data[i + 2]];
          // A translucent text colour shows the background through it.
          per.push(Math.min(...item.colors.map(([r, g, b, a]) => {
            const t = a / 255;
            return ratio([r * t + background[0] * (1 - t), g * t + background[1] * (1 - t), b * t + background[2] * (1 - t)], background);
          })));
        }
        per.sort((p, q) => p - q);
        return per[Math.floor(per.length * 0.05)];
      });
    }, [png, group]);
    group.forEach((item, i) => {
      if (ratios[i] === null) return;
      worst = Math.min(worst, ratios[i]);
      if (ratios[i] < item.need)
        failures.push(`${item.text} (${item.selector}): ${ratios[i].toFixed(2)}:1, needs ${item.need}:1`);
    });
  };
  const viewport = page.viewportSize().height;
  const inHeader = items.filter((item) => item.header);
  if (inHeader.length) await measure(inHeader, 0, true);
  const rest = items.filter((item) => !item.header).sort((a, b) => a.top - b.top);
  while (rest.length) {
    const scroll = Math.max(0, rest[0].top - 120);
    const group = [];
    while (rest.length && rest[0].top < scroll + viewport - 140) group.push(rest.shift());
    await measure(group, scroll, false);
  }
  assert.deepEqual(failures, [], `${label}: contrast measured from pixels`);
  await page.evaluate(() => document.getElementById('hs-audit-style')?.remove());
  return { axeRules: WCAG, pixelChecked: items.length, worstPixelContrast: Number(worst.toFixed(2)) };
}
