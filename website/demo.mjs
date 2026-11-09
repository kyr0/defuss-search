/**
 * The demo's glue: the factory picker, worker events to the runtime card, the result column and the notes board;
 * user input to worker requests. It combines the defuss-lexicalsearch demo (corpus download and index build on page
 * load, notes searchable as you type) with the defuss-vectorsearch demo (models with byte progress, cached for the
 * next visit).
 * The reader picks one of the three factories of defuss-search/strategies before the demo shows, because the choice
 * decides what loads: nothing for lexical-only; MoEdernColBERT (3.83 MB) and the prebuilt token index for tiny; the
 * recorded vectors for lexical-semantic, Winzling (39.8 MB) for own text and MoEdernColBERT for its reranker. Models
 * download from their pinned Hugging Face revisions.
 * The corpus downloads while the reader chooses. `?models=off` keeps the page model-free (slow connections, the
 * model-free e2e run).
 * VERIFIED: scripts/e2e.mjs drives the picker, every factory, examples, typed text, notes, the palette and the
 * in-browser measurement.
 */
import { languageCases } from '../fixtures/languages.mjs';
import { METHODS, factoryOf, gzipBytes, methodOf, modelBytes } from './factories.mjs';
import { createNotesBoard } from './notes.mjs';
import {
  formatMs,
  languageName,
  mb,
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
const MODEL_NAMES = { colbert: 'MoEdernColBERT', winzling: 'Winzling' };
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
    picker: $('factory-picker'),
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
    if (output) output.textContent = done ? 'done' : `${Math.round((100 * loaded) / total)}%`;
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
    el.ring.querySelector('.radial-progress-caption').textContent = done
      ? 'ready'
      : steps.find((name) => state.progress[name] < 1);
    el.ring.dataset.tone = done ? 'success' : '';
    if (state.choice && done && window.demoReady !== state.choice.factory) {
      window.demoReady = state.choice.factory;
      el.status.textContent = readyText();
    }
  };
  const readyText = () =>
    ({
      'lexical-only': 'Ready: every question and your own text search the lexical index.',
      tiny: 'Ready: each query is encoded by MoEdernColBERT and scored against every passage token.',
      semantic: state.choice.rerank
        ? 'Ready: benchmark questions use their recorded vectors; MoEdernColBERT loads with the first question, Winzling with your first own text.'
        : 'Ready: benchmark questions use their recorded vectors; Winzling loads with your first own text.',
    })[state.choice.factory];
  const setStat = (name, text) => {
    document.querySelector(`[data-stat="${name}"]`).textContent = text;
  };
  const log = (tone, text) => {
    for (const line of el.log.querySelectorAll('pre[data-cursor]'))
      line.removeAttribute('data-cursor');
    el.log.insertAdjacentHTML('beforeend', renderLogLine(tone, text));
    while (el.log.children.length > 80) el.log.firstElementChild.remove();
    el.log.scrollTop = el.log.scrollHeight;
  };
  /** The models this factory can use; lexical-semantic needs MoEdernColBERT only for its reranker. */
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
    setStat('models', loaded.length ? loaded.join(' + ') : 'none yet');
    const wanted = factoryModels();
    const button = document.querySelector('[data-load="factory"]');
    button.disabled = !wanted.length || wanted.every((name) => state.models[name] !== 'idle');
    if (state.manifest)
      $('load-all-size').textContent = mb(wanted.reduce((a, n) => a + size(n), 0));
  };
  const size = (name) => modelBytes(state.manifest.models[name].files);

  /** Loads the named models unless they are loading or ready; `?models=off` waits for an explicit click. */
  const load = (names, { explicit = false } = {}) => {
    if (modelsMode === 'off' && !explicit) return;
    const wanted = names.filter((name) => state.models[name] === 'idle');
    if (!wanted.length || !state.manifest) return;
    for (const name of wanted) state.models[name] = 'loading';
    modelState();
    el.status.textContent = `Loading ${wanted.map((name) => MODEL_NAMES[name]).join(' and ')}...`;
    log('info', `load · ${wanted.join(', ')} · device=${el.backend.value}`);
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
  const picked = () => document.querySelector('input[name="factory"]:checked').value;
  const paintPicker = () => {
    const id = picked();
    $('factory-start-name').textContent = factoryOf(id).title;
    $('factory-options').hidden = id !== 'semantic';
  };
  $('factory-group').addEventListener('change', paintPicker);
  const start = () => {
    const factory = picked();
    state.choice = { factory, rerank: factory === 'semantic' && $('factory-rerank').checked };
    const title = `${factoryOf(factory).title}${state.choice.rerank ? ' + reranker' : ''}`;
    $('factory-name').textContent = title;
    for (const node of el.window.querySelectorAll('[data-for]'))
      node.hidden = !node.dataset.for.split(' ').includes(factory);
    // Lexical-semantic without the reranker never loads MoEdernColBERT.
    bars.colbert.closest('.progress-field').hidden = !(factory === 'tiny' || state.choice.rerank);
    $('p-colbert-role').textContent =
      factory === 'tiny'
        ? 'encodes each question and your notes'
        : 'reranker, loads with your first question';
    $('empty-text').textContent = EMPTY[factory];
    el.picker.hidden = true;
    el.window.hidden = false;
    window.demoReady = false;
    paintRing();
    modelState();
    worker.postMessage({ type: 'factory', ...state.choice });
    if (factory === 'tiny') load(['colbert']);
    if (!ready())
      el.status.textContent =
        factory === 'tiny' && modelsMode === 'off'
          ? 'Models are off (?models=off): load MoEdernColBERT to encode questions.'
          : `Preparing ${title}...`;
    // The question on screen runs again under the new factory; a benchmark question may load its reranker, while
    // own text waits for an explicit Search before a Winzling download.
    if (state.bench) {
      askBench(state.bench);
      if (state.bench.example >= 0) needFor(true);
    }
    askNotes();
    el.window.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const EMPTY = {
    'lexical-only':
      'BM25 ranks every question at once, with no model. Paraphrases and translations of the passage words stay out of reach.',
    tiny: 'MoEdernColBERT encodes each question on this device and scores it against every passage token; BM25 joins by rank fusion.',
    semantic:
      'A benchmark question ranks at once with its recorded vector, exactly as in the published figures. Your own text needs Winzling; the reranker needs MoEdernColBERT. Both download once and stay cached.',
  };
  $('factory-start').addEventListener('click', start);
  $('factory-change').addEventListener('click', () => {
    el.window.hidden = true;
    el.picker.hidden = false;
    el.picker.scrollIntoView({ block: 'start', behavior: 'smooth' });
    document.querySelector('input[name="factory"]:checked').focus();
  });

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
  const showBench = (data) => {
    const gold = goldOf();
    el.compare.innerHTML = renderResults(data, { gold, languages: state.languages });
    el.empty.hidden = true;
    el.summary.hidden = false;
    $('summary-query').textContent = data.text;
    const column = data.column;
    const rank =
      column.hits && gold ? column.hits.findIndex((hit) => hit.id === gold.id) + 1 : null;
    $('summary-gold').hidden = !gold;
    if (gold)
      $('summary-gold').textContent =
        `Gold passage: ${rank === null ? '…' : rank ? `#${rank}` : 'not in top 25'}`;
    const timing =
      column.state === 'done' || column.ms ? `search ${formatMs(column.ms)}` : 'waiting';
    $('summary-time').textContent = `${METHODS[data.method].title} · ${
      data.detected ? `${languageName(data.detected)} detected · ` : ''
    }${
      data.recorded
        ? 'recorded question vector · '
        : data.embedMs
          ? `embed ${formatMs(data.embedMs)} · `
          : ''
    }${timing}`;
    document.querySelector('[data-stat="query"]').classList.remove('hs-stat-text');
    setStat(
      'query',
      column.ms === undefined ? 'waiting' : formatMs(column.ms + (data.embedMs ?? 0)),
    );
    setStat('query-detail', METHODS[data.method].title);
    if (data.final) el.compare.removeAttribute('aria-busy');
    state.benchDone = data.final && column.state === 'done';
    if (data.final && gold && column.state === 'done') {
      if (!state.tally.has(data.method)) state.tally.set(data.method, new Map());
      state.tally.get(data.method).set(state.bench.example, rank);
      paintTally();
    }
  };
  const paintTally = () => {
    const parts = [...state.tally].map(([method, ranks]) => {
      const top = [...ranks.values()].filter((rank) => rank === 1).length;
      return `${METHODS[method].title} ${top} of ${ranks.size}`;
    });
    $('tally').hidden = !parts.length;
    $('tally').textContent =
      `Your questions so far, gold passage at #1: ${parts.join(' · ')}. One question is an anecdote; the measurement below runs all 1,000.`;
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
  /** Notes need the factory's document model: Winzling for lexical-semantic, MoEdernColBERT for tiny. */
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
    $('measure-status').textContent =
      factory === 'tiny'
        ? 'Measuring the tiny factory: one ColBERT encoding and token scan per question, a few minutes...'
        : factory === 'semantic' && rerank && state.models.colbert !== 'ready'
          ? 'Measuring efficient; load MoEdernColBERT to measure reranked too...'
          : `Measuring ${METHODS[methodOf(factory, rerank)].title}...`;
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
        el.status.textContent = 'Building the lexical index in a Web Worker...';
      } else
        log('info', `ONNX Runtime Web · ${model} · compiling WebAssembly and creating the session`);
    },
    indexed: (data) => {
      Object.assign(state, { queries: data.queries, languages: data.languages });
      setBar('index', 1, 1, true);
      $('p-index-hint').textContent =
        `${data.terms.toLocaleString('en')} terms in 20 analyzer fields · ${formatMs(data.indexMs)}`;
      setStat('passages', data.passages.toLocaleString('en'));
      setStat('languages', `passages · ${data.languages.length} languages`);
      setStat('indexed', formatMs(data.indexMs));
      $('picker-corpus').textContent =
        `The corpus is ready: ${data.passages.toLocaleString('en')} passages indexed in ${formatMs(data.indexMs)}.`;
      if (!state.choice || ready()) el.status.textContent = state.choice ? readyText() : '';
      $('cmd-placeholder').outerHTML = renderQueryGroups(data.queries, data.languages);
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
      $('examples').innerHTML = renderExampleButtons(picks, data.queries);
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
        $('p-tokens-detail').textContent =
          `${data.tokens.toLocaleString('en')} tokens · ${mb(data.bytes)} of codes · loaded in ${(data.ms / 1000).toFixed(1)} s`;
        window.tokensReady = true;
        if (state.bench && !state.benchDone) askBench(state.bench);
        askNotes();
        return;
      }
      state.models[data.model] = 'ready';
      setBar(data.model, 1, 1, true);
      modelState();
      if (data.model === 'winzling') {
        setStat('device', data.device === 'webgpu' ? 'WebGPU' : 'WASM');
        el.backend.value = data.device;
      }
      el.status.textContent = `${MODEL_NAMES[data.model]} ready in ${(data.ms / 1000).toFixed(1)} s · ${data.cached ? 'from the browser cache' : `${mb(data.downloadedBytes)} downloaded, now cached`}.`;
      window.modelsReady = { ...window.modelsReady, [data.model]: true };
      // Re-run what waited for the model.
      if (state.bench && !state.benchDone) askBench(state.bench);
      askNotes();
    },
    results: (data) => {
      if (data.index === 'notes') {
        if (data.id !== state.notesId) return;
        el.notesCompare.innerHTML = renderResults(data, {
          limit: 8,
          languages: languageCases.map((x) => x.code),
          jump: true,
        });
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
      $('measure-rows').innerHTML = renderMeasure(rows, means);
      $('measure-table').hidden = false;
      $('measure-progress').hidden = true;
      $('measure-run').disabled = false;
      $('measure-status').textContent =
        `${state.queries.length.toLocaleString('en')} questions in ${(data.ms / 1000).toFixed(1)} s in this browser.`;
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
      $('boot-error-title').textContent = data.corpus
        ? 'Loading the corpus failed'
        : data.model
          ? 'Loading a model failed'
          : data.factory
            ? 'Preparing the factory failed'
            : data.cache
              ? 'Clearing the model cache failed'
              : data.notes
                ? 'Encoding your notes failed'
                : 'Search failed';
      $('boot-error-text').textContent = data.message;
      el.error.hidden = false;
      el.compare.removeAttribute('aria-busy');
      window.lastError = data.message;
    },
    cleared: () => log('success', 'model cache cleared · the next load downloads the files again'),
  };
  worker.onmessage = ({ data }) => handlers[data.type]?.(data);
  worker.onerror = (event) =>
    handlers.error({ message: event.message || 'The worker failed to start' });

  fetch(manifestUrl)
    .then((response) => response.json())
    .then((manifest) => {
      state.manifest = manifest;
      $('p-corpus-size').textContent = `${mb(manifest.corpus.bytes)} (gzip)`;
      $('p-vectors-size').textContent = `${mb(manifest.vectors.bytes)} (gzip)`;
      $('p-tokens-size').textContent = `${mb(manifest.tokens.bytes)} (gzip)`;
      // The file size is what the progress counts and the cache keeps; gzipped is the transfer from a host that
      // compresses the model files, which Hugging Face does only for the ColBERT tokenizer.
      const gzipped = (name) => `${mb(gzipBytes(manifest.models[name].files))} gzipped`;
      for (const name of ['colbert', 'winzling'])
        $(`p-${name}-size`).textContent = `${mb(size(name))}, ${gzipped(name)}`;
      const sizes = {
        corpus: manifest.corpus.bytes,
        colbert: size('colbert'),
        winzling: size('winzling'),
        vectors: manifest.vectors.bytes,
        tokens: manifest.tokens.bytes,
      };
      for (const node of document.querySelectorAll('[data-bytes]')) {
        const name = node.dataset.bytes;
        node.textContent =
          'gzipped' in node.dataset ? `${mb(sizes[name])} (${gzipped(name)})` : mb(sizes[name]);
      }
      modelState();
    });
  for (const entry of languageCases) {
    const option = document.createElement('option');
    option.value = entry.code;
    option.textContent = `${languageName(entry.code)} · ${entry.analysis}`;
    el.language.append(option);
  }
  const preset = params.get('factory');
  if (factoryOf(preset)) $(`factory-${preset}`).checked = true;
  paintPicker();
  worker.postMessage({ type: 'index', manifestUrl });
}
