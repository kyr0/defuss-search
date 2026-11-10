/**
 * The playground: an editor (defuss-shadcn code-example's editor without its preview: a textarea over a paint layer
 * that Shiki colours), the example switch, and a console that shows what the snippet logs. The snippet runs in
 * website/playground-worker.mjs; a run that does not answer within five seconds terminates that Worker, and the next
 * run starts a new one.
 * Keys as in code-example: Tab and Shift+Tab indent and outdent, Escape then Tab leaves the editor, Enter keeps the
 * line's indentation; Cmd+Enter or Ctrl+Enter runs.
 * VERIFIED: scripts/e2e.mjs edits and runs a snippet, switches the examples, and checks the console and a timeout.
 */
import { formatMs, onLocale, say, t } from './i18n.mjs';
import { SNIPPETS } from './playground-snippets.mjs';

const TIMEOUT_MS = 5000;
const $ = (id) => document.getElementById(id);

export function initPlayground() {
  const root = $('pg');
  if (!root) return;
  const source = $('pg-source');
  const paint = root.querySelector('.code-example-paint');
  const editor = root.querySelector('.code-example-editor');
  const output = $('pg-output');
  const status = $('pg-status');
  const examples = $('pg-examples');
  let example = 'lexical';
  let highlight = null; // the Shiki module once loaded
  let worker = null;
  let runId = 0;
  let timer = 0;
  let escaped = false;

  source.value = SNIPPETS[example];
  // Colours land once Shiki has loaded; until then the textarea shows its own text.
  const repaint = () => {
    if (!highlight) return;
    paint.innerHTML = `${highlight.highlightLines(source.value, '--code-example').join('\n')}\n`;
    editor.setAttribute('data-painted', '');
    paint.scrollTop = source.scrollTop;
    paint.scrollLeft = source.scrollLeft;
  };
  const loadHighlighter = () =>
    import('./highlight-runtime.mjs').then((module) => {
      highlight = module;
      repaint();
    });
  const fit = () => {
    source.style.height = 'auto';
    source.style.height = `${source.scrollHeight + 2}px`;
  };
  source.addEventListener('input', () => {
    repaint();
    fit();
  });
  source.addEventListener('scroll', () => {
    paint.scrollTop = source.scrollTop;
    paint.scrollLeft = source.scrollLeft;
  });

  const insert = (text) => {
    source.focus();
    // execCommand keeps the browser's undo stack; setRangeText is the fallback where it is gone.
    if (!document.execCommand?.('insertText', false, text)) {
      source.setRangeText(text, source.selectionStart, source.selectionEnd, 'end');
      source.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  source.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      run();
      return;
    }
    if (event.key === 'Escape') {
      escaped = true;
      return;
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (escaped) {
        escaped = false;
        return;
      }
      event.preventDefault();
      const { value, selectionStart: start, selectionEnd: end } = source;
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      if (start === end && !event.shiftKey) return insert('  ');
      const lines = value
        .slice(lineStart, end)
        .split('\n')
        .map((line) => (event.shiftKey ? line.replace(/^ {1,2}/, '') : `  ${line}`))
        .join('\n');
      source.setSelectionRange(lineStart, end);
      insert(lines);
      source.setSelectionRange(lineStart, lineStart + lines.length);
      return;
    }
    escaped = false;
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      const lineStart = source.value.lastIndexOf('\n', source.selectionStart - 1) + 1;
      const indent = /^ */.exec(source.value.slice(lineStart, source.selectionStart))[0];
      if (!indent) return;
      event.preventDefault();
      insert(`\n${indent}`);
    }
  });

  // ---- running -----------------------------------------------------------------------------------------------
  let last = null; // the last result, shown again after a language switch
  const line = (level, html) =>
    `<pre data-prefix="${level === 'error' ? '!' : '>'}"${level === 'error' ? ' data-tone="destructive"' : level === 'warn' ? ' data-tone="warning"' : ''}><code>${html}</code></pre>`;
  const escape = (text) => text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
  const coloured = (text) => (highlight ? highlight.highlightLines(text).join('\n') : escape(text));
  const show = (result) => {
    last = result;
    if (!result) {
      output.innerHTML = line('log', `<span data-msg="pg-idle">${escape(t('pg-idle'))}</span>`);
      return;
    }
    const lines = result.lines.map((entry) => line(entry.level, coloured(entry.text)));
    if (result.error) lines.push(line('error', escape(t('pg-error', { message: result.error }))));
    else if (!result.lines.length) lines.push(line('log', escape(t('pg-silent'))));
    if (result.timeout) lines.push(line('error', escape(t('pg-timeout'))));
    else lines.push(`<pre data-prefix="" data-tone="muted"><code>${escape(t('pg-done', { time: formatMs(result.ms) }))}</code></pre>`);
    output.innerHTML = lines.join('');
  };
  const start = () => {
    worker = new Worker(
      new URL(`./playground-worker.js${new URL(import.meta.url).search}`, import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = ({ data }) => {
      if (data.id !== runId) return;
      clearTimeout(timer);
      root.removeAttribute('aria-busy');
      show(data);
      say(status, 'pg-done', () => ({ time: formatMs(data.ms) }));
      window.playgroundResult = data;
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      root.removeAttribute('aria-busy');
      show({ lines: [], ms: 0, error: event.message || 'Worker error' });
    };
  };
  function run() {
    if (!worker) start();
    runId += 1;
    clearTimeout(timer);
    root.setAttribute('aria-busy', 'true');
    say(status, 'pg-running');
    output.innerHTML = line('log', escape(t('pg-running')));
    worker.postMessage({ id: runId, code: source.value });
    const id = runId;
    timer = setTimeout(() => {
      if (id !== runId) return;
      // The snippet did not answer: end its Worker, so the next run starts fresh.
      worker.terminate();
      worker = null;
      root.removeAttribute('aria-busy');
      show({ lines: [], ms: TIMEOUT_MS, timeout: true });
      say(status, 'pg-timeout');
      window.playgroundResult = { timeout: true };
    }, TIMEOUT_MS);
  }
  $('pg-run').addEventListener('click', run);
  $('pg-reset').addEventListener('click', () => {
    source.value = SNIPPETS[example];
    repaint();
    fit();
    show(null);
  });
  $('pg-copy').addEventListener('click', async () => {
    const label = $('pg-copy').querySelector('span');
    let ok = true;
    try {
      await navigator.clipboard.writeText(source.value);
    } catch {
      ok = false;
    }
    say(label, ok ? 'copied' : 'copy-failed');
    setTimeout(() => say(label, 'copy'), 2000);
  });
  examples.addEventListener('click', (event) => {
    const button = event.target.closest('button[value]');
    if (!button) return;
    // After the toggle group's own handler: one example is always pressed.
    queueMicrotask(() => {
      example = button.value;
      for (const other of examples.querySelectorAll('button[value]'))
        other.setAttribute('aria-pressed', String(other === button));
      source.value = SNIPPETS[example];
      repaint();
      fit();
      show(null);
    });
  });
  onLocale(() => show(last));

  fit();
  // Shiki and the Worker start once the playground comes near the viewport; a page that never scrolls there loads
  // neither.
  const near = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      near.disconnect();
      loadHighlighter().then(() => show(last));
      if (!worker) start();
    },
    { rootMargin: '600px 0px' },
  );
  near.observe(root);
}
