/**
 * The notes board of the "My data (custom)" tab, after the defuss-vectorsearch demo: yellow notes the user writes.
 * Each note goes to the worker 500 ms after the last keystroke, or when it loses focus. The worker indexes it
 * lexically at once and adds what the chosen factory needs once its model is loaded (a Winzling-embed vector or ColBERT
 * tokens), so lexical search over notes works before any model download. The board numbers the requests, so an answer for an older text never marks a newer one as indexed.
 * A written note's language follows its text: the worker asks defuss-lid, as for a typed question, and the menu shows
 * the answer, until the reader picks a language for that note. A sample note keeps the language it was written in.
 * VERIFIED: scripts/e2e.mjs adds five random notes, waits for the count and finds note-1 by its longest word, and a
 * German note typed under an English default ends up in the German field.
 */
import { languageCases } from '../fixtures/languages.mjs';
import { formatMs, locale, onLocale, t } from './i18n.mjs';
import { renderNote, renderNoteStatus } from './render.mjs';
import { SAMPLE_NOTES } from './sample-notes.mjs';

const DEBOUNCE_MS = 500;
const CODES = languageCases.map((x) => x.code);
const codeOf = Object.fromEntries(languageCases.map((x) => [x.entry, x.code]));

export function createNotesBoard({ list, empty, count, worker, needModel, onChange }) {
  const notes = new Map(); // id → { version, text, language, timer, picked }: text and language as last sent
  let next = 1;
  // A new note starts in the language last picked, at first the browser's, so typing needs no extra step.
  let lastLanguage = codeOf[globalThis.navigator?.language?.split('-')[0]] ?? 'eng_Latn';
  const element = (id) => document.getElementById(id);
  const statuses = new Map(); // id -> [state, detail, kind], written again after a language switch
  const setStatus = (id, state, detail, kind) => {
    // detail may be a function, so a time it formats follows the next language
    statuses.set(id, [state, detail, kind]);
    const text = typeof detail === 'function' ? detail() : detail;
    element(id).querySelector('.hs-note-status').innerHTML = renderNoteStatus(state, text, kind);
  };
  let kind = 'none';
  let last = { count: 0, embeddedCount: 0 };
  const updateCount = (counts = { count: notes.size, embeddedCount: 0, kind }) => {
    kind = counts.kind ?? kind;
    last = counts;
    const plural = new Intl.PluralRules(locale.locale).select(counts.count) === 'one' ? 'one' : 'other';
    const total = t(`notes-${plural}`, { count: counts.count });
    const verb = { vector: 'notes-embedded', matrix: 'notes-encoded' }[kind];
    count.textContent = verb ? t(verb, { notes: total, count: counts.embeddedCount }) : total;
    empty.hidden = notes.size > 0;
  };
  // A language switch writes the count, the note labels and their statuses again.
  onLocale(() => {
    updateCount(last);
    for (const [id, args] of statuses) if (element(id)) setStatus(id, ...args);
    for (const [id] of notes) {
      const n = id.replace('note-', '');
      const note = element(id);
      if (!note) continue;
      note.querySelector('.hs-note-label').textContent = t('note-label', { n });
      note.querySelector('select').setAttribute('aria-label', t('note-language', { n }));
      note.querySelector('textarea').placeholder = t('note-placeholder');
    }
  });

  /** Sends the note when its text or language changed since the last request; empty text removes the note. */
  const index = (id) => {
    const note = notes.get(id);
    clearTimeout(note.timer);
    const text = element(id).querySelector('textarea').value;
    const language = element(id).querySelector('select').value;
    if (text === note.text && language === note.language) return;
    // A language change of a note that was never indexed has nothing to re-index.
    const unsent = !text.trim() && !note.text?.trim();
    note.text = text;
    note.language = language;
    if (unsent) return;
    note.version += 1;
    element(id).setAttribute('aria-busy', 'true');
    if (text.trim()) needModel();
    worker.postMessage({ type: 'note', id, version: note.version, text, language, detect: !note.picked });
  };

  const add = ({ text = '', language = lastLanguage, focus = true, picked = false } = {}) => {
    const id = `note-${next}`;
    const n = next++;
    notes.set(id, { version: 0, text: '', language, timer: 0, picked });
    list.insertAdjacentHTML('beforeend', renderNote(id, n, language, CODES));
    const textarea = element(id).querySelector('textarea');
    textarea.value = text;
    element(id)
      .querySelector('select')
      .addEventListener('change', (event) => {
        lastLanguage = event.target.value;
        notes.get(id).picked = true;
        textarea.lang = event.target.value.replace('_', '-');
        index(id);
      });
    textarea.addEventListener('input', () => {
      const note = notes.get(id);
      clearTimeout(note.timer);
      note.timer = setTimeout(() => index(id), DEBOUNCE_MS);
    });
    textarea.addEventListener('blur', () => index(id));
    updateCount();
    if (focus) textarea.focus();
    if (text) index(id);
    return id;
  };

  // A shuffled deck: repeated clicks draw new notes until all 100 have been used once.
  let deck = [];
  const draw = () => {
    if (!deck.length) {
      deck = SAMPLE_NOTES.map((_, i) => i);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
    }
    return SAMPLE_NOTES[deck.pop()];
  };
  const addRandom = (amount) => {
    for (let i = 0; i < amount; i++) {
      const { text, lang } = draw();
      add({ text, language: codeOf[lang], focus: false, picked: true });
    }
    const scroller = list.closest('.hs-notes-scroll');
    scroller.scrollTo({ top: scroller.scrollHeight });
  };

  /** Scrolls the board to a note, highlights it briefly and focuses its text, so keyboard users land there too. */
  let flash = 0;
  const reveal = (id) => {
    const note = element(id);
    if (!note) return;
    note.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    for (const other of list.querySelectorAll('[data-flash]')) other.removeAttribute('data-flash');
    note.setAttribute('data-flash', '');
    clearTimeout(flash);
    flash = setTimeout(() => note.removeAttribute('data-flash'), 1600);
    note.querySelector('textarea').focus({ preventScroll: true });
  };

  return {
    add,
    addRandom,
    reveal,
    /** A factory change changes what "embedded" counts: Winzling-embed vectors, ColBERT tokens or nothing. */
    setCounts: (counts) => updateCount(counts),
    onNote: (data) => {
      const note = notes.get(data.id);
      // version -1: the worker represented a waiting note after a model load or a factory change.
      if (!note || (data.version !== -1 && data.version !== note.version)) return;
      if (data.version !== -1) element(data.id).removeAttribute('aria-busy');
      // The worker filed the note under the language defuss-lid read; the menu shows it, a pick overrides it.
      if (data.language && !note.picked && data.language !== note.language) {
        note.language = data.language;
        element(data.id).querySelector('select').value = data.language;
        element(data.id).querySelector('textarea').lang = data.language.replace('_', '-');
      }
      if (data.removed) setStatus(data.id, 'removed');
      else if (data.embedded)
        setStatus(
          data.id,
          'hybrid',
          data.embedMs
            ? () => t('note-time', { kind: t(`note-kind-${data.kind}`), time: formatMs(data.embedMs) })
            : '',
          data.kind,
        );
      else setStatus(data.id, 'lexical', '', data.kind);
      updateCount(data);
      onChange();
    },
    onError: (id, text) => {
      if (!notes.has(id)) return;
      element(id).removeAttribute('aria-busy');
      notes.get(id).text = null; // the next edit or blur tries again
      setStatus(id, 'failed', text);
    },
  };
}
