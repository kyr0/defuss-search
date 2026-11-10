/**
 * Page chrome shared by the main page and the rendered Markdown pages: the theme switch, the copy buttons, the
 * package manager switch, the platform's modifier key, entrance animations when an element scrolls into view, and
 * the diagrams' labels after a language switch. The theme key and its JSON value match defuss-lexicalsearch and
 * defuss-vectorsearch, so the inline head script reads either.
 * VERIFIED: e2e toggles the theme, follows the system scheme, reads the clipboard after the copy buttons and switches
 * the package manager.
 */
import { onLocale, say } from './i18n.mjs';

const THEME_KEY = 'defuss-shadcn-theme';
const PM_KEY = 'defuss-search:package-manager';
/** macOS and iPadOS show the Command key; other systems use Ctrl for the same shortcuts. */
export const isMac = () =>
  /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');

function initTheme() {
  const toggle = document.querySelector('#theme-toggle');
  if (!toggle) return;
  const apply = (dark) => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    toggle.checked = dark;
  };
  toggle.checked = document.documentElement.classList.contains('dark');
  toggle.addEventListener('change', () => {
    apply(toggle.checked);
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(toggle.checked ? 'dark' : 'light'));
    } catch {
      /* Storage may be disabled; the switch still works for this page. */
    }
  });
  // Until the reader picks a theme here, the page follows the system's, also when it changes while the page is open.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {
      /* no storage: follow the system */
    }
    if (!saved) apply(event.matches);
  });
}

async function copy(text, status) {
  try {
    await navigator.clipboard.writeText(text);
    if (status) say(status, 'copied');
    return true;
  } catch {
    if (status) say(status, 'copy-failed');
    return false;
  }
}
/** A button label that says Copied for two seconds. */
function flash(label, ok, idle) {
  if (!label) return;
  say(label, ok ? 'copied' : 'copy-failed');
  setTimeout(() => say(label, idle), 2000);
}

function initCopy() {
  for (const block of document.querySelectorAll('.mk-code-block'))
    block
      .querySelector('.mk-code-block-copy')
      ?.addEventListener('click', () =>
        copy(block.querySelector('code').innerText, block.querySelector('.mk-code-block-status')),
      );
  const prompt = document.querySelector('#copy-prompt');
  prompt?.addEventListener('click', async () => {
    const text = [...document.querySelectorAll('#agent-prompt pre:not([data-tone]) code')]
      .map((code) => code.textContent)
      .join('\n');
    flash(prompt.querySelector('span'), await copy(text, document.querySelector('#copy-prompt-status')), 'copy-prompt');
  });
}

/**
 * The install switches: one toggle group per terminal, all on the same package manager. The choice is kept for the
 * next visit; site.css shows only the pressed one's line.
 */
function initInstall() {
  const blocks = [...document.querySelectorAll('[data-install]')];
  if (!blocks.length) return;
  const kept = globalThis.df$?.store?.persisted?.(PM_KEY, 'bun');
  const show = (pm) => {
    for (const block of blocks) {
      block.dataset.pm = pm;
      for (const button of block.querySelectorAll('.toggle-group button[value]'))
        button.setAttribute('aria-pressed', String(button.value === pm));
    }
    if (kept && kept.value !== pm) kept.set(pm);
  };
  show(kept?.value ?? 'bun');
  for (const block of blocks) {
    block.querySelector('.toggle-group').addEventListener('click', (event) => {
      const button = event.target.closest('button[value]');
      // After the toggle group's own handler, which would let a second press clear the item.
      if (button) queueMicrotask(() => show(button.value));
    });
    const button = block.querySelector('[data-copy-install]');
    button.addEventListener('click', async () => {
      const line = block.querySelector(`pre[data-pm="${block.dataset.pm}"] code`);
      flash(button.querySelector('span'), await copy(line.textContent, block.querySelector('[data-copy-status]')), 'copy');
    });
  }
}

/** Shortcuts show ⌘ on Apple systems and Ctrl elsewhere; the keys work with either (website/playground.mjs). */
function paintModifiers() {
  if (isMac()) return;
  for (const key of document.querySelectorAll('kbd[data-mod]')) key.textContent = 'Ctrl';
}

/**
 * Elements with `data-enter` play their defuss-shadcn entrance (motion.css) the first time a fifth of them is in
 * view, not on load, so a reader sees them arrive; reduced motion shows them at once (motion.css).
 */
function initEntrances() {
  const items = document.querySelectorAll('[data-enter]');
  document.documentElement.classList.add('hs-entrances');
  if (!items.length) return;
  if (typeof IntersectionObserver !== 'function') {
    for (const item of items) item.dataset.dfEntrance = item.dataset.enter;
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        entry.target.dataset.dfEntrance = entry.target.dataset.enter;
      }
    },
    { threshold: 0.2 },
  );
  for (const item of items) observer.observe(item);
}

/**
 * A stepped diagram that plays when it scrolls into view shows every part until then, and its first step hides most
 * of them again: all, then few, then all, a flicker. VERIFIED (frame sampling, 2026-11-09): 22 parts, then 14, then
 * one more per step. Until the diagram starts, site.css hides the parts its first step hides, so they appear once.
 * With reduced motion the diagram does not play, and nothing is hidden.
 */
function initDiagramStart() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const figure of document.querySelectorAll('figure.diagram[data-steps][data-autoplay]')) {
    figure.classList.add('hs-awaiting');
    // Released by the first step, by the reader's first press on the diagram or its toolbar ("Show all"), or two
    // seconds after it came into view, so no part stays hidden if the diagram does not play.
    const panel = figure.closest('.tab-content') ?? figure;
    const release = () => {
      figure.classList.remove('hs-awaiting');
      started.disconnect();
      seen.disconnect();
      panel.removeEventListener('pointerdown', release);
      panel.removeEventListener('keydown', release);
    };
    const started = new MutationObserver(() => {
      if (figure.querySelector('[data-step-state]')) release();
    });
    started.observe(figure, { subtree: true, attributes: true, attributeFilter: ['data-step-state'] });
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setTimeout(release, 2000);
    });
    seen.observe(figure);
    panel.addEventListener('pointerdown', release);
    panel.addEventListener('keydown', release);
  }
}

export function initChrome() {
  initTheme();
  initCopy();
  initInstall();
  initEntrances();
  initDiagramStart();
  paintModifiers();
  onLocale(() => {
    // Translated regions bring their ⌘ back, and a diagram draws its wire labels from the edge list.
    paintModifiers();
    for (const figure of document.querySelectorAll('figure.diagram'))
      globalThis.df$?.shadcn?.diagram?.redraw?.(figure);
  });
}
