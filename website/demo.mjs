/**
 * The demo's glue: the factory picker, worker events to the runtime card, the result column and the notes board;
 * user input to worker requests. It combines the defuss-lexicalsearch demo (corpus download and index build on page
 * load, notes searchable as you type) with the defuss-vectorsearch demo (models with byte progress, cached for the
 * next visit).
 * The reader picks one of the three factories of defuss-search/strategies before the demo shows, because the choice
 * decides what loads: nothing for lexical-only; Winzling-reranker (3.83 MB) and the prebuilt token index for tiny; the
 * recorded vectors for lexical-semantic, Winzling-embed (39.8 MB) for own text and Winzling-reranker for its reranker. Models
 * download from their pinned Hugging Face revisions.
 * The corpus downloads while the reader chooses. `?models=off` keeps the page model-free (slow connections, the
 * model-free e2e run).
 * VERIFIED: scripts/e2e.mjs drives the picker, every factory, examples, typed text, notes, the palette and the
 * in-browser measurement.
 */
import { languageCases } from '../fixtures/languages.mjs';
import { METHODS, factoryOf, methodOf, modelBytes } from './factories.mjs';
import {
  formatMb,
  formatMs,
  formatNumber,
  formatSeconds,
  languageName,
  onLocale,
  percent,
  say,
  t,
} from './i18n.mjs';
import { createNotesBoard } from './notes.mjs';
import {
  renderExampleButtons,
  renderLogLine,
  renderMeasure,
  renderQueryGroups,
  renderResults,
} from './render.mjs';

const K = [1, 5, 10, 25];
/** The steps a factory waits for before its first search; optional model loads stay out of the ring. */
const REQUIRED = {
  'lexical-only': ['corpus', 'index'],
  tiny: ['corpus', 'index', 'colbert', 'tokens'],
  semantic: ['corpus', 'index', 'vectors'],
};
const MODEL_NAMES = { colbert: 'Winzling-reranker', winzling: 'Winzling-embed' };
const $ = (id) => document.getElementById(id);

export function initDemo() {
  const params = new URL(location.href).searchParams;
  const modelsMode = params.get('models');
  const manifestUrl = new URL('../data/manifest.json', import.meta.url).href;
  // The page's `?v=<build>` (scripts/website-build.mjs) keys the worker to the same build in the browser cache.
  const worker = new Worker(
    new URL(`./search-worker.js${new URL(import.meta.url).search}`, import.meta.url),
    { type: 'module' },
  );
  const el = {
    window: $('demo-window'),
    ring: $('ring'),
    status: $('boot-status'),
    log: $('log'),
    backend: $('backend'),
    error: $('boot-error'),
    cmd: $('cmd'),
    language: $('language'),
    query: $('query'),
    form: $('form'),
    compare: $('compare'),
    summary: $('summary'),
    empty: $('empty'),
    notesQuery: $('notes-query'),
    notesCompare: $('notes-compare'),
  };
  const bars = Object.fromEntries(
    ['corpus', 'index', 'vectors', 'colbert', 'tokens', 'winzling'].map((name) => [
      name,
      $(`p-${name}`),
    ]),
  );
  const state = {
    queries: [],
    languages: [],
    manifest: null,
    choice: null, // { factory, rerank } once the demo started
    progress: { corpus: 0, index: 0, vectors: 0, colbert: 0, tokens: 0, winzling: 0 },
    models: { colbert: 'idle', winzling: 'idle' },
    bench: null, // the current benchmark search: { id, text, example, language }
    notesId: 0,
    tally: new Map(), // method → Map(example index → gold rank)
    measured: new Map(), // method → measurement row
  };

  // ---- the runtime card --------------------------------------------------------------------------------------------
  const setBar = (name, loaded, total, done) => {
    const bar = bars[name];
    bar.max = total;
    bar.value = loaded;
    const output = document.querySelector(`output[for="${bar.id}"]`);
    // A download names its size, as in the defuss-vectorsearch demo: "40% of 2.28 MB"; the index build only a share.
    if (output)
      say(output, done ? 'done' : name === 'index' ? 'value' : 'value-of', () => ({
        value: percent(loaded / total, 0),
        size: formatMb(total),
      }));
    bar.dataset.tone = done ? 'success' : '';
    // A finished download or encoding is not ready yet: only the worker's 'ready' event completes a step.
    state.progress[name] = done ? 1 : Math.min(loaded / total, 0.99);
    paintRing();
  };
  const required = () => REQUIRED[state.choice?.factory ?? 'lexical-only'];
  const ready = () => required().every((name) => state.progress[name] === 1);
  const paintRing = () => {
    const steps = required();
    // Readiness comes from the steps, not the rounded percentage: 3.99 of 4 steps must not show 100%.
    const done = ready();
    const value = done
      ? 100
      : Math.min(
          99,
          Math.round(
            (100 * steps.reduce((sum, name) => sum + state.progress[name], 0)) / steps.length,
          ),
        );
    el.ring.style.setProperty('--value', value);
    el.ring.setAttribute('aria-valuenow', value);
    el.ring.querySelector('.radial-progress-value').textContent = `${value}%`;
    say(
      el.ring.querySelector('.radial-progress-caption'),
      done ? 'ready' : `step-${steps.find((name) => state.progress[name] < 1)}`,
    );
    el.ring.dataset.tone = done ? 'success' : '';
    if (state.choice && done && window.demoReady !== state.choice.factory) {
      window.demoReady = state.choice.factory;
      say(el.status, readyKey());
    }
  };
  const readyKey = () =>
    state.choice.factory === 'semantic' && state.choice.rerank
      ? 'ready-semantic-rerank'
      : `ready-${state.choice.factory}`;
  /** A figure of the runtime card; `value` is a function, so it formats again after a language switch. */
  const setStat = (name, value) =>
    say(document.querySelector(`[data-stat="${name}"]`), 'value', () => ({ value: value() }));
  const log = (tone, text) => {
    for (const line of el.log.querySelectorAll('pre[data-cursor]'))
      line.removeAttribute('data-cursor');
    el.log.insertAdjacentHTML('beforeend', renderLogLine(tone, text));
    while (el.log.children.length > 80) el.log.firstElementChild.remove();
    el.log.scrollTop = el.log.scrollHeight;
  };
  /** The models this factory can use; lexical-semantic needs Winzling-reranker only for its reranker. */
  const factoryModels = () =>
    !state.choice
      ? []
      : state.choice.factory === 'tiny'
        ? ['colbert']
        : state.choice.factory === 'semantic'
          ? [...(state.choice.rerank ? ['colbert'] : []), 'winzling']
          : [];
  const modelState = () => {
    const loaded = Object.entries(state.models)
      .filter(([, value]) => value === 'ready')
      .map(([name]) => MODEL_NAMES[name]);
    if (loaded.length) setStat('models', () => loaded.join(' + '));
    else say(document.querySelector('[data-stat="models"]'), 'none-yet');
    const wanted = factoryModels();
    const button = document.querySelector('[data-load="factory"]');
    button.disabled = !wanted.length || wanted.every((name) => state.models[name] !== 'idle');
    if (state.manifest)
      say($('load-all-size'), 'value', () => ({
        value: formatMb(wanted.reduce((a, n) => a + size(n), 0)),
      }));
  };
  const size = (name) => modelBytes(state.manifest.models[name].files);

  /** Loads the named models unless they are loading or ready; `?models=off` waits for an explicit click. */
  const load = (names, { explicit = false } = {}) => {
    if (modelsMode === 'off' && !explicit) return;
    const wanted = names.filter((name) => state.models[name] === 'idle');
    if (!wanted.length || !state.manifest) return;
    for (const name of wanted) state.models[name] = 'loading';
    modelState();
    say(el.status, 'loading-models', () => ({
      models: wanted.map((name) => MODEL_NAMES[name]).join(` ${t('and')} `),
    }));
    log('info', `load ${wanted.join(', ')}, device=${el.backend.value}`);
    worker.postMessage({ type: 'load', models: wanted, device: el.backend.value });
  };
  /** What a question or own text needs before the chosen factory can answer it. */
  const needFor = (example) => {
    const { factory, rerank } = state.choice;
    if (factory === 'tiny') load(['colbert']);
    if (factory === 'semantic')
      load([...(rerank ? ['colbert'] : []), ...(example ? [] : ['winzling'])]);
  };

  // ---- the factory picker ------------------------------------------------------------------------------------------
  // A pick starts its factory at once; Lexical-semantic tiny starts by itself when the demo comes near the view, so
  // a reader who never scrolls there downloads no model.
  const picked = () => document.querySelector('input[name="factory"]:checked').value;
  const start = () => {
    const factory = picked();
    state.choice = { factory, rerank: factory === 'semantic' && $('factory-rerank').checked };
    const title = () =>
      state.choice.rerank
        ? t('with-reranker', { title: factoryOf(factory).title })
        : factoryOf(factory).title;
    say($('factory-name'), 'value', () => ({ value: title() }));
    for (const node of el.window.querySelectorAll('[data-for]'))
      node.hidden = !node.dataset.for.split(' ').includes(factory);
    // Lexical-semantic without the reranker never loads Winzling-reranker.
    bars.colbert.closest('.progress-field').hidden = !(factory === 'tiny' || state.choice.rerank);
    say($('p-colbert-role'), factory === 'tiny' ? 'role-encoder' : 'role-reranker');
    say($('empty-text'), `empty-${factory}`);
    el.window.hidden = false;
    window.demoReady = false;
    paintRing();
    modelState();
    worker.postMessage({ type: 'factory', ...state.choice });
    if (factory === 'tiny') load(['colbert']);
    if (!ready()) {
      if (factory === 'tiny' && modelsMode === 'off') say(el.status, 'models-off');
      else say(el.status, 'preparing', () => ({ title: title() }));
    }
    // The question on screen runs again under the new factory; a benchmark question may load its reranker, while
    // own text waits for an explicit Search before a Winzling-embed download.
    if (state.bench) {
      askBench(state.bench);
      if (state.bench.example >= 0) needFor(true);
    } else runFirstExample();
    askNotes();
  };
  $('factory-group').addEventListener('change', (event) => {
    // The reranker switch belongs to Lexical-semantic: turning it picks that factory.
    if (event.target.id === 'factory-rerank') $('factory-semantic').checked = true;
    start();
  });
  new IntersectionObserver(
    (entries, observer) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      if (!state.choice) start();
    },
    { rootMargin: '100% 0px' },
  ).observe($('demo'));

  // ---- benchmark search ------------------------------------------------------------------------------------------
  let searchId = 0;
  let debounce = 0;
  // detect: the worker reads the question's language and searches that field; a benchmark question or a language the
  // reader picked is searched as asked.
  const askBench = ({ text, example = -1, language = el.language.value, detect = false }) => {
    clearTimeout(debounce);
    if (!state.choice || !state.queries.length || !text.trim()) return;
    state.bench = { id: ++searchId, text, example, language, detect };
    el.compare.setAttribute('aria-busy', 'true');
    worker.postMessage({
      type: 'search',
      index: 'bench',
      id: searchId,
      text,
      language,
      example,
      detect,
      ...state.choice,
    });
  };
  /** The first example runs by itself once the corpus is indexed, unless models are off or a question is set. */
  const runFirstExample = () => {
    if (!state.choice || state.bench || modelsMode === 'off' || state.firstExample === undefined) return;
    askExample(state.firstExample);
  };
  const askExample = (i) => {
    const query = state.queries[i];
    el.language.value = state.languages[query.language];
    el.query.value = query.text;
    $('tab-bench').click();
    askBench({ text: query.text, example: i });
    needFor(true);
  };
  /** The gold passage of the current question, while the box still holds that example's text. */
  const goldOf = () => {
    const query = state.queries[state.bench?.example];
    if (!query || query.text !== state.bench.text) return undefined;
    // Passages are stored group by group, one per language, so the row's remainder is its language.
    return { id: `${query.group}:${query.gold % state.languages.length}`, group: query.group };
  };
  /** The result column and its summary; called again after a language switch with the same data. */
  const paintBench = (data) => {
    const gold = goldOf();
    el.compare.innerHTML = renderResults(data, { gold, languages: state.languages });
    const column = data.column;
    const rank =
      column.hits && gold ? column.hits.findIndex((hit) => hit.id === gold.id) + 1 : null;
    $('summary-gold').hidden = !gold;
    if (gold)
      say(
        $('summary-gold'),
        rank === null ? 'gold-pending' : rank ? 'gold-rank' : 'gold-missing',
        { rank },
      );
    say($('summary-time'), 'value', () => ({
      value: [
        METHODS[data.method].title,
        data.detected ? t('summary-detected', { language: languageName(data.detected) }) : '',
        data.recorded
          ? t('summary-recorded')
          : data.embedMs
            ? t('summary-embed', { time: formatMs(data.embedMs) })
            : '',
        column.state === 'done' || column.ms
          ? t('summary-search', { time: formatMs(column.ms) })
          : t('waiting'),
      ]
        .filter(Boolean)
        .join(', '),
    }));
    return { gold, rank };
  };
  let lastBench = null;
  const showBench = (data) => {
    lastBench = data;
    const { gold, rank } = paintBench(data);
    const column = data.column;
    el.empty.hidden = true;
    el.summary.hidden = false;
    $('summary-query').textContent = data.text;
    if (data.final) el.compare.removeAttribute('aria-busy');
    state.benchDone = data.final && column.state === 'done';
    if (data.final && gold && column.state === 'done') {
      if (!state.tally.has(data.method)) state.tally.set(data.method, new Map());
      state.tally.get(data.method).set(state.bench.example, rank);
      paintTally();
    }
  };
  const tallyParts = () =>
    [...state.tally].map(([method, ranks]) =>
      t('tally-part', {
        method: METHODS[method].title,
        top: [...ranks.values()].filter((rank) => rank === 1).length,
        total: ranks.size,
      }),
    );
  const paintTally = () => {
    const parts = tallyParts();
    $('tally').hidden = !parts.length;
    say($('tally'), 'tally', () => ({ parts: tallyParts().join(', ') }));
  };

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.query.value.trim();
    if (!text) {
      el.query.focus();
      return;
    }
    const example = state.queries.findIndex((query) => query.text === text);
    askBench({ text, example, detect: example < 0 });
    needFor(example >= 0);
  });
  // Typing searches as you go; only Search starts a model download.
  el.query.addEventListener('input', () => {
    clearTimeout(debounce);
    const text = el.query.value.trim();
    if (!text) {
      el.summary.hidden = true;
      el.empty.hidden = false;
      el.compare.innerHTML = '';
      lastBench = null;
      return;
    }
    debounce = setTimeout(() => {
      const example = state.queries.findIndex((q) => q.text === text);
      askBench({ text, example, detect: example < 0 });
    }, 120);
  });
  // Only a different language runs the question again; a repeated run would report the cached ColBERT scan's time.
  el.language.addEventListener('change', () => {
    if (state.bench && state.bench.language !== el.language.value)
      askBench({ ...state.bench, language: el.language.value, detect: false });
  });
  $('examples').addEventListener('click', (event) => {
    const button = event.target.closest('[data-query]');
    if (button) askExample(Number(button.dataset.query));
  });
  $('cmd-list').addEventListener('click', (event) => {
    const item = event.target.closest('.command-item[data-query]');
    if (!item) return;
    if (el.cmd.api) el.cmd.api.setState('default');
    else el.cmd.close();
    askExample(Number(item.dataset.query));
  });
  // A column's load button, or the card's, loads what the factory needs.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-load]');
    if (!button) return;
    const name = button.dataset.load;
    load(name === 'factory' ? factoryModels() : [name], { explicit: true });
  });
  $('clear-cache').addEventListener('click', () => worker.postMessage({ type: 'clear-cache' }));
  $('boot-retry').addEventListener('click', () => {
    el.error.hidden = true;
    if (!state.queries.length) worker.postMessage({ type: 'index', manifestUrl });
    else if (state.choice) worker.postMessage({ type: 'factory', ...state.choice });
  });

  // ---- notes ----------------------------------------------------------------------------------------------------
  let notesDebounce = 0;
  let lastNotes = null;
  let lastMeasure = null;
  const paintNotes = (data) => {
    el.notesCompare.innerHTML = renderResults(data, {
      limit: 8,
      languages: languageCases.map((x) => x.code),
      jump: true,
    });
  };
  const askNotes = () => {
    const text = el.notesQuery.value.trim();
    $('notes-cta').hidden = !!text;
    if (!text || !state.choice) {
      el.notesCompare.innerHTML = '';
      return;
    }
    state.notesId += 1;
    el.notesCompare.setAttribute('aria-busy', 'true');
    worker.postMessage({
      type: 'search',
      index: 'notes',
      id: state.notesId,
      text,
      ...state.choice,
    });
  };
  /** Notes need the factory's document model: Winzling-embed for lexical-semantic, Winzling-reranker for tiny. */
  const needNoteModel = () => {
    if (state.choice?.factory === 'semantic') load(['winzling']);
    if (state.choice?.factory === 'tiny') load(['colbert']);
  };
  const board = createNotesBoard({
    list: $('notes'),
    empty: $('notes-empty'),
    count: $('notes-count'),
    worker,
    needModel: needNoteModel,
    onChange: askNotes,
  });
  $('add-note').addEventListener('click', () => board.add());
  // A result's text shows its note on the board.
  el.notesCompare.addEventListener('click', (event) => {
    const button = event.target.closest('[data-note]');
    if (button) board.reveal(button.dataset.note);
  });
  $('add-random-notes').addEventListener('click', () => board.addRandom(5));
  el.notesQuery.addEventListener('input', () => {
    clearTimeout(notesDebounce);
    notesDebounce = setTimeout(askNotes, 120);
  });
  $('notes-form').addEventListener('submit', (event) => {
    event.preventDefault();
    askNotes();
    needNoteModel();
  });
  for (const link of document.querySelectorAll('[data-tab]'))
    link.addEventListener('click', () => $(link.dataset.tab).click());

  // ---- measurement ----------------------------------------------------------------------------------------------
  const recall = fetch(new URL('../data/recall.json', import.meta.url)).then((r) => r.json());
  const strategies = fetch(new URL('../data/strategies.json', import.meta.url)).then((r) =>
    r.json(),
  );
  $('measure-run').addEventListener('click', () => {
    $('measure-run').disabled = true;
    $('measure-progress').hidden = false;
    const { factory, rerank } = state.choice;
    if (factory === 'tiny') say($('measure-status'), 'measure-tiny');
    else if (factory === 'semantic' && rerank && state.models.colbert !== 'ready')
      say($('measure-status'), 'measure-efficient-first');
    else say($('measure-status'), 'measure-method', { method: METHODS[methodOf(factory, rerank)].title });
    worker.postMessage({ type: 'measure' });
  });
  const summarize = (ranks) => {
    const codes = state.languages;
    return Object.fromEntries(
      K.map((k) => {
        const perLanguage = codes.map((_, language) => {
          const own = state.queries
            .map((query, i) => [query, ranks[i]])
            .filter(([query]) => query.language === language);
          return own.filter(([, rank]) => rank > 0 && rank <= k).length / own.length;
        });
        return [`r${k}`, perLanguage.reduce((a, b) => a + b, 0) / perLanguage.length];
      }),
    );
  };

  // ---- worker events --------------------------------------------------------------------------------------------
  const handlers = {
    log: ({ tone, text }) => log(tone, text),
    progress: ({ phase, loaded, total }) => setBar(phase, loaded, total, false),
    phase: ({ phase, model }) => {
      if (phase === 'index') {
        setBar('corpus', 1, 1, true);
        bars.index.removeAttribute('value');
        say(el.status, 'boot-index');
      } else log('info', `ONNX Runtime Web, ${model}: compiling WebAssembly and creating the session`);
    },
    indexed: (data) => {
      Object.assign(state, { queries: data.queries, languages: data.languages });
      setBar('index', 1, 1, true);
      say($('p-index-hint'), 'index-terms', () => ({
        terms: formatNumber(data.terms),
        time: formatMs(data.indexMs),
      }));
      setStat('passages', () => formatNumber(data.passages));
      say(document.querySelector('[data-stat="languages"]'), 'stat-languages', {
        count: data.languages.length,
      });
      setStat('indexed', () => formatMs(data.indexMs));
      say($('picker-corpus'), 'picker-ready', () => ({
        passages: formatNumber(data.passages),
        time: formatMs(data.indexMs),
      }));
      if (state.choice && ready()) say(el.status, readyKey());
      else if (!state.choice) {
        el.status.textContent = '';
        delete el.status.dataset.msg;
      }
      $('cmd-list').innerHTML = renderQueryGroups(data.queries, data.languages);
      const own = new Intl.Locale(navigator.language || 'en').language;
      const preferred = data.languages.findIndex(
        (code) => Intl.getCanonicalLocales(code.split('_')[0])[0] === own,
      );
      el.language.value = data.languages[Math.max(0, preferred)];
      const firstOf = (code) => data.queries.findIndex((q) => data.languages[q.language] === code);
      const picks = [
        ...new Set([
          firstOf(el.language.value),
          firstOf('eng_Latn'),
          firstOf('deu_Latn'),
          firstOf('jpn_Jpan'),
        ]),
      ].filter((i) => i >= 0);
      $('examples').innerHTML = renderExampleButtons(picks, data.queries, data.languages);
      state.firstExample = picks[0];
      runFirstExample();
      for (const button of document.querySelectorAll('[data-needs-corpus]'))
        button.disabled = false;
      window.corpusReady = true;
    },
    probe: ({ cached }) => {
      const names = Object.keys(cached).filter((name) => cached[name]);
      if (names.length && modelsMode !== 'off')
        log('success', `${names.join(' and ')} found in the browser cache`);
    },
    // The notes index follows the factory; a search asked during the switch runs again on the rebuilt one.
    chosen: (data) => {
      board.setCounts(data);
      askNotes();
    },
    ready: (data) => {
      if (data.model === 'vectors') {
        setBar('vectors', 1, 1, true);
        if (state.bench && !state.benchDone) askBench(state.bench);
        return;
      }
      if (data.model === 'tokens') {
        setBar('tokens', 1, 1, true);
        say($('p-tokens-detail'), 'tokens-loaded', () => ({
          tokens: formatNumber(data.tokens),
          size: formatMb(data.bytes),
          seconds: formatSeconds(data.ms),
        }));
        window.tokensReady = true;
        if (state.bench && !state.benchDone) askBench(state.bench);
        askNotes();
        return;
      }
      state.models[data.model] = 'ready';
      setBar(data.model, 1, 1, true);
      modelState();
      if (data.model === 'winzling') {
        setStat('device', () => (data.device === 'webgpu' ? 'WebGPU' : 'WASM'));
        el.backend.value = data.device;
      }
      say(el.status, data.cached ? 'model-ready-cached' : 'model-ready-downloaded', () => ({
        model: MODEL_NAMES[data.model],
        seconds: formatSeconds(data.ms),
        size: formatMb(data.downloadedBytes ?? 0),
      }));
      window.modelsReady = { ...window.modelsReady, [data.model]: true };
      // Re-run what waited for the model.
      if (state.bench && !state.benchDone) askBench(state.bench);
      askNotes();
    },
    results: (data) => {
      if (data.index === 'notes') {
        if (data.id !== state.notesId) return;
        lastNotes = data;
        paintNotes(data);
        if (data.final) {
          el.notesCompare.removeAttribute('aria-busy');
          window.lastNotes = data;
        }
        return;
      }
      if (data.id !== state.bench?.id) return; // a newer question is on its way
      // The worker searched the detected language's field; the menu shows it, and a pick from the menu overrides it.
      // VERIFIED: scripts/e2e.mjs checks both in Chromium.
      if (data.detected) el.language.value = state.bench.language = data.detected;
      showBench(data);
      if (data.final) window.lastSearch = { ...data, gold: goldOf() };
    },
    note: (data) => board.onNote(data),
    'measure-progress': ({ done, total }) => {
      $('measure-progress').max = total;
      $('measure-progress').value = done;
    },
    measured: async (data) => {
      const [reference, published] = await Promise.all([recall, strategies]);
      const means = {
        ...Object.fromEntries(
          ['lexical-only', 'tiny'].map((id) => [id, published.corpora.belebele[id]]),
        ),
        ...Object.fromEntries(reference.presets.map((preset) => [preset.id, preset.mean])),
      };
      for (const [id, ranks] of Object.entries(data.ranks))
        state.measured.set(id, {
          id,
          mean: summarize(ranks),
          neural: id === 'reranked' ? data.neural : 0,
        });
      const rows = [...state.measured.values()];
      lastMeasure = { rows, means };
      $('measure-rows').innerHTML = renderMeasure(rows, means);
      $('measure-table').hidden = false;
      $('measure-progress').hidden = true;
      $('measure-run').disabled = false;
      say($('measure-status'), 'measure-done', () => ({
        questions: formatNumber(state.queries.length),
        seconds: formatSeconds(data.ms),
      }));
      window.lastMeasure = {
        factory: data.factory,
        ranks: data.ranks,
        rows,
        neural: data.neural,
        languages: state.queries.map((query) => state.languages[query.language]),
      };
    },
    error: (data) => {
      log('destructive', data.message);
      if (data.model && state.models[data.model]) {
        state.models[data.model] = 'idle';
        modelState();
      }
      if (data.note) board.onError(data.note, data.message);
      if (data.measure) $('measure-run').disabled = false;
      say(
        $('boot-error-title'),
        data.corpus
          ? 'error-corpus'
          : data.model
            ? 'error-model'
            : data.factory
              ? 'error-factory'
              : data.cache
                ? 'error-cache'
                : data.notes
                  ? 'error-notes'
                  : 'error-search',
      );
      $('boot-error-text').textContent = data.message;
      el.error.hidden = false;
      el.compare.removeAttribute('aria-busy');
      window.lastError = data.message;
    },
    cleared: () => log('success', 'model cache cleared, the next load downloads the files again'),
  };
  worker.onmessage = ({ data }) => handlers[data.type]?.(data);
  worker.onerror = (event) =>
    handlers.error({ message: event.message || t('error-worker') });

  fetch(manifestUrl)
    .then((response) => response.json())
    .then((manifest) => {
      state.manifest = manifest;
      // Every size is a download: the `.br` file the worker fetches and its progress counts (scripts/demo-data.mjs).
      for (const name of ['corpus', 'vectors', 'tokens'])
        say($(`p-${name}-size`), 'size-brotli', () => ({ size: formatMb(manifest[name].bytes) }));
      for (const name of ['colbert', 'winzling'])
        say($(`p-${name}-size`), 'size-brotli', () => ({ size: formatMb(size(name)) }));
      // The `data-bytes` sizes are in the built page already, filled from this manifest (scripts/figures.mjs).
      modelState();
    });
  /** The question languages, named in the page language; a switch keeps the selection. */
  const paintLanguages = () => {
    const selected = el.language.value;
    el.language.replaceChildren(
      ...languageCases.map((entry) => {
        const option = document.createElement('option');
        option.value = entry.code;
        option.textContent = t('language-option', {
          language: languageName(entry.code),
          analysis: t(`analysis-${entry.analysis.replace(' ', '-')}`),
        });
        return option;
      }),
    );
    if (selected) el.language.value = selected;
  };
  paintLanguages();
  // `/` jumps to the question box (the shortcut the page shows), unless the reader is typing somewhere.
  globalThis.df$?.shadcn?.shared?.bindGlobalKeys?.((event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return false;
    event.preventDefault();
    const target = el.window.hidden ? $('factory-group') : el.query;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true });
    return true;
  });
  // What the scripts wrote follows a language switch: the language menu, the palette, the results and the
  // measurement; texts written with say() repaint themselves (website/i18n.mjs).
  onLocale(() => {
    paintLanguages();
    if (state.queries.length) $('cmd-list').innerHTML = renderQueryGroups(state.queries, state.languages);
    if (lastBench) paintBench(lastBench);
    if (lastNotes) paintNotes(lastNotes);
    if (lastMeasure) $('measure-rows').innerHTML = renderMeasure(lastMeasure.rows, lastMeasure.means);
  });
  const preset = params.get('factory');
  if (factoryOf(preset)) $(`factory-${preset}`).checked = true;
  worker.postMessage({ type: 'index', manifestUrl });
}
