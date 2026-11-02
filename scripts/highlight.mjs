/**
 * Build-time syntax highlighting for the rendered Markdown pages, in the defuss-shadcn code block markup
 * (mk-code-block-k|s|n|c spans, one span per line) that the main page uses. A regular-expression tokenizer
 * covers the ts, js and sh fences in docs/; a full grammar package would add a dependency for no visible gain.
 * VERIFIED: e2e finds keyword spans in the reference page's code blocks (session 2026-11-01).
 */
const KEYWORDS = new Set(
  'import export from as const let var await async function return new if else for of in class extends type interface implements throw try catch finally typeof keyof readonly true false null undefined'.split(
    ' ',
  ),
);
const escape = (text) =>
  text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const SCRIPT =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g;
const SHELL = /(#[^\n]*)|('[^'\n]*'|"(?:\\.|[^"\\\n])*")|(^|\s)(\d+(?:\.\d+)?)(?=\s|$)/gm;

/** Splits code into [text, class] segments; class is k (keyword), s (string), n (number), c (comment) or ''. */
function segments(code, lang) {
  const out = [];
  let last = 0;
  const shell = lang === 'sh' || lang === 'bash';
  for (const match of code.matchAll(shell ? SHELL : SCRIPT)) {
    const [whole, comment, string] = match;
    let start = match.index,
      text = whole,
      kind = comment ? 'c' : string ? 's' : 'n';
    if (shell && match[4]) {
      start += match[3].length;
      text = match[4];
    } else if (!shell && match[4]) {
      if (!KEYWORDS.has(match[4])) continue;
      kind = 'k';
    }
    out.push([code.slice(last, start), ''], [text, kind]);
    last = start + text.length;
  }
  out.push([code.slice(last), '']);
  return out;
}

/** Highlighted HTML lines; a token that spans lines is closed and reopened on each line. */
export function highlight(code, lang = '') {
  const lines = [''];
  for (const [text, kind] of segments(code, lang))
    text.split('\n').forEach((part, i) => {
      if (i) lines.push('');
      if (part)
        lines[lines.length - 1] += kind
          ? `<span class="mk-code-block-${kind}">${escape(part)}</span>`
          : escape(part);
    });
  return lines;
}

/** One file-style code block with a copy button, as on the main page. */
export function codeBlock(code, lang = '') {
  const lines = highlight(code.replace(/\n$/, ''), lang)
    .map((line) => `<span>${line}</span>`)
    .join('');
  return `<figure class="mk-code-block" data-variant="file"><div class="mk-code-block-head"><span class="mk-code-block-file">${escape(lang || 'text')}</span><button class="mk-code-block-copy" type="button" aria-label="Copy code"><svg class="hs-icon" aria-hidden="true" viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button></div><pre data-numbers><code>${lines}</code></pre><span class="mk-code-block-status" role="status"></span></figure>`;
}
