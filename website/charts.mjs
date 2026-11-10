/**
 * The performance section: four charts over docs/data/strategies.json and docs/data/pareto.json, each driven by its
 * toggle groups, with a table of the same numbers below it. The defuss-shadcn chart component draws them with
 * ECharts and follows the theme; this module builds the options, in the page language.
 * Why the numbers come from the JSON at run time: they are the files the benchmarks write, and scripts/e2e.mjs
 * compares every table cell with them, so a chart cannot show a figure the reports do not hold.
 * VERIFIED: scripts/e2e-site.mjs compares every table cell with docs/data and drives each control.
 */
import { shareAxis } from './axis.mjs';
import { METHODS } from './factories.mjs';
import { formatMs, formatNumber, onLocale, percent, t } from './i18n.mjs';

const FACTORIES = ['lexical-only', 'tiny', 'efficient', 'reranked'];
const SETS = [
  'belebele',
  'notes translation',
  'notes paraphrase',
  'notes keyword',
  'api fixture exact',
  'api fixture paraphrase',
  'api docs exact',
  'api docs natural',
];
const CORPORA = ['belebele', 'notes', 'api fixture', 'api docs'];
/**
 * One colour per factory, in a fixed order, stepped for each theme: the categorical slots 1 to 4 of the dataviz
 * reference palette (blue, orange, aqua, yellow), which pass its colour-vision checks on light and dark surfaces.
 * Light mode has two slots under 3:1 against the card, so every chart has direct labels or a legend and a table.
 * The vector indexes take the colour of the factory that uses them: Winzling-embed efficient's, ColBERT tiny's.
 */
const PALETTE = {
  light: { 'lexical-only': '#2a78d6', tiny: '#eb6834', efficient: '#1baf7a', reranked: '#eda100', other: '#8a8986' },
  dark: { 'lexical-only': '#3987e5', tiny: '#d95926', efficient: '#199e70', reranked: '#c98500', other: '#6f6e6a' },
};
const isDark = () => document.documentElement.classList.contains('dark');
const colors = () => PALETTE[isDark() ? 'dark' : 'light'];
/** What a factory downloads to answer text queries: none, Winzling-reranker, Winzling-embed, Winzling-embed and Winzling-reranker. */
const downloads = (modelBytes) => ({
  'lexical-only': 0,
  tiny: modelBytes.colbert,
  efficient: modelBytes.winzling,
  reranked: modelBytes.winzling + modelBytes.colbert,
});
const mb = (bytes) =>
  bytes ? `${formatNumber(bytes / 1e6, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB` : t('chart-none');
const escape = (text) =>
  String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const table = (head, rows) =>
  `<table class="table hs-bench-table" data-size="sm"><thead><tr>${head.map((cell, i) => `<th scope="col"${i ? ' class="hs-num"' : ''}>${escape(cell)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr${row.attrs ? ` ${row.attrs}` : ''}>${row.cells.map((cell, i) => (i ? `<td class="hs-num">${escape(cell)}</td>` : `<th scope="row">${escape(cell)}</th>`)).join('')}</tr>`)
    .join('')}</tbody></table>`;

/** The pressed value of a single-choice toggle group, or every pressed value of a multiple one. */
const pressed = (group) => [...group.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.value);

/** A chart narrower than this wraps its category names and shows fewer axis labels. */
const NARROW = 480;
const narrow = (id) => (document.getElementById(id)?.clientWidth ?? NARROW) < NARROW;

function qualityOption(data, state) {
  const sets = SETS.filter((set) => data.corpora[set]);
  const color = colors();
  const tight = narrow('chart-quality');
  return {
    aria: { enabled: true },
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    grid: { left: 8, right: 24, top: 44, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (value) => percent(value) },
    xAxis: {
      type: 'value',
      min: 0,
      max: 1,
      interval: tight ? 0.5 : 0.2,
      axisLabel: { formatter: (value) => percent(value, 0), hideOverlap: true },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: sets.map((set) => t(`set-${set}`)),
      axisLabel: { width: tight ? 112 : 160, overflow: 'break', lineHeight: 14 },
    },
    // The toggles' short names, so the legend stays on one line.
    series: FACTORIES.filter((id) => state.series.includes(id)).map((id) => ({
      id,
      name: SHORT[id],
      type: 'bar',
      barMaxWidth: 10,
      barGap: '30%',
      barCategoryGap: '40%',
      itemStyle: { color: color[id], borderRadius: [0, 4, 4, 0] },
      data: sets.map((set) => data.corpora[set][id][state.k]),
    })),
  };
}

/** The factories' short names, as on the toggles: labels next to points stay short. */
const SHORT = { 'lexical-only': 'Lexical-only', tiny: 'Tiny', efficient: 'Efficient', reranked: 'Reranked' };
/**
 * Point labels that cannot collide: points that nearly coincide by `near` (efficient and reranked usually do)
 * share one label on the first of them, and the others show none. Points carry `id`, `name`, `x` and `y`.
 */
function pointLabels(points, near) {
  const labels = new Map();
  const placed = [];
  for (const point of points) {
    const host = placed.find((other) => near(other, point));
    if (host) labels.set(host.id, `${labels.get(host.id)}, ${point.name}`);
    else {
      placed.push(point);
      labels.set(point.id, point.name);
    }
  }
  return (id) => (placed.some((point) => point.id === id) ? labels.get(id) : '');
}
/** Label sides that alternate above and below the points, left to right, so wide neighbours never meet. */
const alternate = (points, label) =>
  new Map(
    points
      .filter((point) => label(point.id))
      .sort((a, b) => a.x - b.x)
      .map((point, i) => [point.id, i % 2 ? 'bottom' : 'top']),
  );

function tradeoffOption(data, state) {
  const sizes = downloads(data.modelBytes);
  const rows = data.corpora[state.corpus];
  const color = colors();
  const points = FACTORIES.map((id) => ({ id, name: SHORT[id], x: Math.max(rows[id].ms, 0.05), y: rows[id][state.k] }));
  const label = pointLabels(points, (a, b) => Math.abs(Math.log10(a.x / b.x)) < 0.3 && Math.abs(a.y - b.y) < 0.03);
  const side = alternate(points, label);
  return {
    aria: { enabled: true },
    grid: { left: 8, right: 48, top: 36, bottom: 36, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: ({ data: point }) =>
        `<strong>${escape(point.name)}</strong><br>${state.k.toUpperCase().replace('R', 'R@')}: ${percent(point.value[1])}<br>${t('chart-time-short')}: ${formatMs(point.value[0])}<br>${t('chart-download')}: ${mb(point.bytes)}`,
    },
    // From 0.01 ms, so the fastest point and its label keep a margin from the axis.
    xAxis: { type: 'log', min: 0.01, name: t('chart-time'), nameLocation: 'middle', nameGap: 28, axisLabel: { formatter: (value) => formatNumber(value) } },
    yAxis: { type: 'value', ...shareAxis(points.map((point) => point.y)), axisLabel: { formatter: (value) => percent(value, 0) } },
    series: [
      {
        id: 'factories',
        type: 'scatter',
        data: FACTORIES.map((id) => ({
          name: METHODS[id].title,
          value: [Math.max(rows[id].ms, 0.05), rows[id][state.k]],
          bytes: sizes[id],
          symbolSize: 10 + Math.sqrt(sizes[id] / 1e6) * 3,
          itemStyle: { color: color[id], opacity: 0.85, borderColor: isDark() ? '#1a1a19' : '#ffffff', borderWidth: 2 },
          label: { show: !!label(id), position: side.get(id) ?? 'bottom', distance: 6, formatter: label(id) },
        })),
        labelLayout: { moveOverlap: 'shiftY' },
      },
    ],
  };
}

function sizeOption(data) {
  const index = data.indexBytesPerDocument;
  const corpora = CORPORA.filter((corpus) => index[corpus]);
  const color = colors();
  const tight = narrow('chart-size');
  return {
    aria: { enabled: true },
    // On a phone the two legend items take two lines; the plot starts below them.
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    grid: { left: 8, right: 24, top: tight ? 64 : 44, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (value) => `${formatNumber(value)} B` },
    xAxis: { type: 'value', splitNumber: tight ? 2 : 5, axisLabel: { formatter: (value) => formatNumber(value), hideOverlap: true } },
    yAxis: {
      type: 'category',
      inverse: true,
      data: corpora.map((corpus) => t(`corpus-${corpus}`)),
      axisLabel: { width: tight ? 112 : 160, overflow: 'break', lineHeight: 14 },
    },
    series: [
      { id: 'winzling', name: t('chart-winzling'), type: 'bar', barMaxWidth: 12, barGap: '25%', itemStyle: { color: color.efficient, borderRadius: [0, 4, 4, 0] }, data: corpora.map((c) => index[c].winzlingFloat32) },
      { id: 'colbert', name: t('chart-colbert'), type: 'bar', barMaxWidth: 12, itemStyle: { color: color.tiny, borderRadius: [0, 4, 4, 0] }, data: corpora.map((c) => index[c].colbertTurboQuant) },
    ],
  };
}

function frontierOption(pareto, state) {
  const { results, frontier } = pareto.holdout;
  const color = colors();
  // Only the frontier is labelled; configurations on the same spot share a label, and a label at the y axis sits to
  // the right of its point, clear of the axis labels.
  const labelled = results
    .filter((row) => frontier.includes(row.name))
    .map((row) => ({ id: row.name, name: row.name, x: row.neuralQueries, y: row[state.k] }));
  const label = pointLabels(labelled, (a, b) => Math.abs(a.x - b.x) < 60 && Math.abs(a.y - b.y) < 0.04);
  const side = alternate(labelled, label);
  return {
    aria: { enabled: true },
    grid: { left: 8, right: 32, top: 32, bottom: 36, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: ({ data: point }) =>
        `<strong>${escape(point.name)}</strong><br>${state.k.toUpperCase().replace('R', 'R@')}: ${percent(point.value[1])}<br>${t('chart-calls')}: ${formatNumber(point.value[0])}`,
    },
    xAxis: { type: 'value', name: t('chart-calls'), nameLocation: 'middle', nameGap: 28, min: -20, max: 520, axisLabel: { formatter: (value) => (value < 0 || value > 500 ? '' : formatNumber(value)) } },
    yAxis: { type: 'value', ...shareAxis(results.map((row) => row[state.k])), axisLabel: { formatter: (value) => percent(value, 0) } },
    series: [
      {
        id: 'configurations',
        type: 'scatter',
        data: results.map((row) => {
          const front = frontier.includes(row.name);
          // The tooltip names every configuration.
          return {
            name: row.name,
            value: [row.neuralQueries, row[state.k]],
            symbolSize: front ? 14 : 9,
            itemStyle: { color: front ? color['lexical-only'] : color.other, opacity: front ? 1 : 0.7 },
            label: { show: !!label(row.name), position: row.neuralQueries < 60 ? 'right' : (side.get(row.name) ?? 'top'), distance: 8, formatter: label(row.name) },
          };
        }),
        labelLayout: { moveOverlap: 'shiftY' },
      },
    ],
  };
}

/** The tables under the charts and the frontier table, in the page language. */
function paintTables(data, pareto) {
  const sizes = downloads(data.modelBytes);
  const sets = SETS.filter((set) => data.corpora[set]);
  const quality = document.querySelector('[data-chart-table="quality"]');
  if (quality)
    quality.innerHTML = table(
      [t('chart-query-set'), ...FACTORIES.map((id) => METHODS[id].title)],
      sets.flatMap((set) =>
        ['r1', 'r5', 'r10', 'r25'].map((k) => ({
          attrs: `data-row="${escape(set)}" data-k="${k}"`,
          cells: [`${t(`set-${set}`)}, R@${k.slice(1)}`, ...FACTORIES.map((id) => percent(data.corpora[set][id][k]))],
        })),
      ),
    );
  const tradeoff = document.querySelector('[data-chart-table="tradeoff"]');
  if (tradeoff)
    tradeoff.innerHTML = table(
      [t('chart-factory'), t('chart-time-short'), t('chart-download')],
      FACTORIES.map((id) => ({
        attrs: `data-row="${id}"`,
        cells: [METHODS[id].title, formatMs(data.corpora.belebele[id].ms), mb(sizes[id])],
      })),
    );
  const size = document.querySelector('[data-chart-table="size"]');
  if (size)
    size.innerHTML = table(
      [t('chart-corpus'), t('chart-winzling'), t('chart-colbert')],
      CORPORA.filter((corpus) => data.indexBytesPerDocument[corpus]).map((corpus) => ({
        attrs: `data-row="${escape(corpus)}"`,
        cells: [
          t(`corpus-${corpus}`),
          formatNumber(data.indexBytesPerDocument[corpus].winzlingFloat32),
          formatNumber(data.indexBytesPerDocument[corpus].colbertTurboQuant),
        ],
      })),
    );
  const front = document.querySelector('#pareto-results');
  if (front)
    front.innerHTML = pareto.holdout.results
      .filter((row) => pareto.holdout.frontier.includes(row.name))
      .map(
        (row) =>
          `<tr data-row="${escape(row.name)}"><th scope="row">${escape(row.name)}</th>${['r1', 'r5', 'candidateRecall'].map((key) => `<td class="hs-num">${percent(row[key])}</td>`).join('')}<td class="hs-num">${formatNumber(row.vectorQueries)}</td><td class="hs-num">${formatNumber(row.neuralQueries)}</td></tr>`,
      )
      .join('');
}

const load = (path) =>
  fetch(new URL(path, import.meta.url)).then((response) => {
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  });

export function initCharts() {
  const section = document.querySelector('#performance');
  if (!section) return;
  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    const [, data, pareto] = await Promise.all([
      import('./echarts-setup.mjs'),
      load('../data/strategies.json'),
      load('../data/pareto.json'),
    ]);
    const chart = globalThis.df$.shadcn.chart;
    const cards = [
      ['chart-quality', (state) => qualityOption(data, state), { k: 'r5', series: ['tiny', 'reranked'] }],
      ['chart-tradeoff', (state) => tradeoffOption(data, state), { k: 'r5', corpus: 'belebele' }],
      ['chart-size', () => sizeOption(data), {}],
      ['chart-frontier', (state) => frontierOption(pareto, state), { k: 'r1' }],
    ].map(([id, build, state]) => {
      const el = document.getElementById(id);
      const mounted = chart.mount(el, build(state));
      const card = el.closest('.hs-chart-card');
      // Merged by series id, so a changed factor moves the bars and points from their old values instead of
      // drawing the chart again from zero; replaceMerge drops a series the reader switched off.
      const paint = () => mounted.setOption(build(state), { replaceMerge: ['series'] });
      for (const control of card.querySelectorAll('[data-chart-control]')) {
        const key = control.dataset.chartControl;
        // A group with data-max shows at most that many: a further press releases the oldest one.
        const order = control.localName === 'select' ? [] : pressed(control);
        const read = (button) => {
          if (control.localName === 'select') state[key] = control.value;
          else {
            // A second press would clear the item: a single choice keeps one value pressed, and at least one
            // factory stays shown.
            if (!pressed(control).length && button) button.setAttribute('aria-pressed', 'true');
            if (button && control.dataset.max) {
              const at = order.indexOf(button.value);
              if (at >= 0) order.splice(at, 1);
              if (button.getAttribute('aria-pressed') === 'true') order.push(button.value);
              while (order.length > Number(control.dataset.max))
                control.querySelector(`button[value="${order.shift()}"]`).setAttribute('aria-pressed', 'false');
            }
            const values = pressed(control);
            state[key] = control.dataset.type === 'single' ? values[0] : values;
          }
          paint();
          el.dataset.state = JSON.stringify(state);
        };
        if (control.localName === 'select') control.addEventListener('change', () => read());
        else
          control.addEventListener('click', (event) => {
            const button = event.target.closest('button[value]');
            if (button) queueMicrotask(() => read(button));
          });
      }
      el.dataset.state = JSON.stringify(state);
      return paint;
    });
    paintTables(data, pareto);
    onLocale(() => {
      for (const paint of cards) paint();
      paintTables(data, pareto);
    });
    // Crossing the narrow width changes the axes: draw again then, not on every resize.
    let wasNarrow = narrow('chart-quality');
    new ResizeObserver(() => {
      if (wasNarrow === narrow('chart-quality')) return;
      wasNarrow = !wasNarrow;
      for (const paint of cards) paint();
    }).observe(document.getElementById('chart-quality'));
    // The palette has a step per theme: a theme switch draws the charts again.
    let dark = isDark();
    new MutationObserver(() => {
      if (dark === isDark()) return;
      dark = isDark();
      for (const paint of cards) paint();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    window.chartsReady = true;
  };
  const near = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      near.disconnect();
      start();
    },
    { rootMargin: '800px 0px' },
  );
  near.observe(section);
}
