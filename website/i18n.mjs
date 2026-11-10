/**
 * The page language, English or German. defuss-i18n switches the marked regions (scripts/localize.mjs wrote their
 * templates at build time); this module owns the choice and everything a script writes:
 * - the first language is the one the reader chose before, else the first of the browser's languages that the site
 *   has (navigator.languages, `de-AT` finds `de`), else English. The inline head script makes the same choice
 *   before the first paint, so a German reader never sees English text flash;
 * - `t(key, values)` gives the messages of website/messages.mjs in the current language, `formatNumber` its number
 *   format, and `onLocale(fn)` lets a script write its text again after a switch;
 * - elements with `data-num` show a number in the language's format (`data-num-style="percent"` for shares).
 * Why the choice lives in a df$ persisted store: the components' own runtime keeps it, in one key, across visits
 * and pages; a blocked storage keeps it for this page.
 * VERIFIED: make e2e opens the page with a German browser language, switches and reloads to check the stored choice.
 */
import { createDomI18n, createI18n, resolveLocale } from 'defuss-i18n/core';
import { MESSAGES } from './messages.mjs';

export const LOCALES = ['en', 'de'];
export const LANGUAGE_KEY = 'defuss-search:language';
const kept = globalThis.df$?.store?.persisted?.(LANGUAGE_KEY, '');

/** The reader's earlier choice, else the first browser language the site has, else English. */
export function preferredLocale(saved = kept?.value, languages = globalThis.navigator?.languages ?? []) {
  if (LOCALES.includes(saved)) return saved;
  for (const tag of languages) {
    const match = resolveLocale(LOCALES, tag, []);
    if (match) return match;
  }
  return 'en';
}

export const locale = createI18n({ locale: preferredLocale(), fallback: ['en'] });

/** The message `key` in the current language, `{name}` placeholders filled from `values`. */
export function t(key, values = {}) {
  const text = MESSAGES[locale.locale]?.[key] ?? MESSAGES.en[key];
  if (text === undefined) throw new Error(`No message ${key}`);
  return text.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`Message ${key} needs ${name}`);
    return String(values[name]);
  });
}
export const formatNumber = (value, options) => locale.formatNumber(value, options);
/** A share in [0, 1] as a percentage with one decimal: 91.2% or 91,2 %. */
export const percent = (share, digits = 1) =>
  locale.formatNumber(share, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Calls `fn` after every language switch (and once now with `{ immediate: true }`). */
export const onLocale = (fn, options) => locale.subscribe(fn, options);

/** Milliseconds as the demo shows them: one decimal below 10 ms. */
export const formatMs = (ms) =>
  `${formatNumber(ms, ms < 10 ? { minimumFractionDigits: 1, maximumFractionDigits: 1 } : { maximumFractionDigits: 0 })} ms`;
export const formatSeconds = (ms) =>
  `${formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
export const formatMb = (bytes) =>
  `${formatNumber(bytes / 1e6, { minimumFractionDigits: bytes >= 1e7 ? 1 : 2, maximumFractionDigits: bytes >= 1e7 ? 1 : 2 })} MB`;
/** A language of the benchmark ("deu_Latn") by its name in the page language. */
export const languageName = (code) => {
  try {
    return new Intl.DisplayNames([locale.locale], { type: 'language' }).of(code.split('_')[0]) ?? code;
  } catch {
    return code;
  }
};

const said = new WeakMap();
/**
 * Writes message `key` into `el` and keeps it, so the element shows it again in the next language. `values` may be
 * a function: it runs again after a switch, so numbers it formats follow the new language.
 */
export function say(el, key, values = {}) {
  if (!el) return;
  said.set(el, { key, values });
  el.dataset.msg = key;
  el.textContent = t(key, typeof values === 'function' ? values() : values);
}

/** Every number, language name and kept message on the page, in the current language. */
function paintNumbers(scope = document) {
  for (const el of scope.querySelectorAll('[data-num]')) {
    const value = Number(el.dataset.num);
    const digits = Number(el.dataset.numDigits ?? 1);
    el.textContent =
      el.dataset.numStyle === 'percent'
        ? percent(value, digits)
        : `${formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${el.dataset.numUnit ?? ''}`;
  }
  for (const el of scope.querySelectorAll('[data-lang-name]')) el.textContent = languageName(el.dataset.langName);
  for (const el of scope.querySelectorAll('[data-msg]')) {
    const kept = said.get(el);
    if (kept?.key === el.dataset.msg)
      el.textContent = t(kept.key, typeof kept.values === 'function' ? kept.values() : kept.values);
    else if (MESSAGES.en[el.dataset.msg] !== undefined && !/\{\w+\}/.test(MESSAGES.en[el.dataset.msg]))
      el.textContent = t(el.dataset.msg);
  }
}

/**
 * Binds the page's translated regions under `root`, the language switches (`[data-locale-switch]` toggle groups)
 * and the document's lang and title. Returns the binding.
 */
export function initI18n(root = document.querySelector('[data-i18n-component]')) {
  const binding = root ? createDomI18n(globalThis.df$).bind(root, locale) : null;
  const switches = [...document.querySelectorAll('[data-locale-switch]')];
  const titles = { en: document.title, de: document.documentElement.dataset.titleDe ?? document.title };
  const paintSwitches = (tag) => {
    for (const group of switches)
      for (const button of group.querySelectorAll('button[value]'))
        button.setAttribute('aria-pressed', String(button.value === tag));
  };
  const paint = ({ locale: tag }) => {
    document.documentElement.lang = tag;
    document.title = titles[tag] ?? titles.en;
    paintSwitches(tag);
    paintNumbers();
  };
  locale.subscribe(paint, { immediate: true });
  for (const group of switches)
    group.addEventListener('click', (event) => {
      const button = event.target.closest('button[value]');
      if (!button) return;
      // After the toggle group's own handler: a second press would clear the item, but a language switch always
      // shows the current language.
      queueMicrotask(() => {
        locale.setLocale(button.value);
        paintSwitches(locale.locale);
        // Only a choice is kept: until the reader picks one, the browser's language decides on every visit.
        if (kept && kept.value !== locale.locale) kept.set(locale.locale);
      });
    });
  document.documentElement.classList.remove('hs-pending');
  return binding;
}
export { paintNumbers };
