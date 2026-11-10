/**
 * Build-time syntax highlighting with Shiki for every code sample of the website: the file-style code blocks of the
 * main page and the rendered Markdown pages, and the terminal lines of the command windows (defuss-shadcn
 * mockup-code). Each token carries its light and dark colour (github-light and github-dark, raised to WCAG AA by
 * website/shiki-themes.mjs) as `--shiki-light` / `--shiki-dark`; site.css picks the one for the surface.
 * Why at build time: the page shows coloured code before, and without, its scripts, and loads no highlighter for it;
 * only the playground's editor highlights while you type (website/highlight-runtime.mjs, the same themes).
 * VERIFIED: make e2e checks that the built pages' code carries Shiki's token spans.
 */
import { createHighlighter } from 'shiki';
import { DARK, LIGHT, THEMES } from '../website/shiki-themes.mjs';

const LANGS = { js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', bash: 'bash', json: 'json' };
const highlighter = await createHighlighter({
  themes: [LIGHT, DARK],
  langs: [...new Set(Object.values(LANGS))],
});

export const escape = (text) =>
  text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const style = (htmlStyle = {}) =>
  Object.entries(htmlStyle)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');

/** One HTML string per line of `code`; an unknown or empty language yields plain escaped text. */
export function highlight(code, lang = '') {
  const language = LANGS[lang] ?? (Object.values(LANGS).includes(lang) ? lang : null);
  if (!language) return code.split('\n').map(escape);
  const { tokens } = highlighter.codeToTokens(code, { lang: language, themes: THEMES, defaultColor: false });
  return tokens.map((line) =>
    line
      .map((token) => {
        const css = style(token.htmlStyle);
        return css ? `<span style="${css}">${escape(token.content)}</span>` : escape(token.content);
      })
      .join(''),
  );
}

const COPY_ICON =
  '<svg class="hs-icon" aria-hidden="true" viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const FILE_ICON = '<svg class="hs-icon" aria-hidden="true"><use href="#i-file"/></svg>';

/** One file-style code block with a copy button; `file` names the head, `id` the code element. */
export function codeBlock(code, lang = '', { file, id } = {}) {
  const lines = highlight(code.replace(/\n$/, ''), lang)
    .map((line) => `<span>${line}</span>`)
    .join('');
  const head = file ? `${FILE_ICON}${escape(file)}` : escape(lang || 'text');
  return `<figure class="mk-code-block hs-shiki" data-variant="file"><div class="mk-code-block-head"><span class="mk-code-block-file">${head}</span><button class="mk-code-block-copy" type="button" aria-label="Copy code">${COPY_ICON}</button></div><pre data-numbers><code${id ? ` id="${escape(id)}"` : ''}>${lines}</code></pre><span class="mk-code-block-status" role="status"></span></figure>`;
}

/** Terminal lines: `$ ` starts a command (the prompt is generated content, never copied); other lines are output. */
export function terminalLines(text, lang = 'bash') {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => {
      const command = line.startsWith('$ ');
      const body = command ? highlight(line.slice(2), lang)[0] : escape(line);
      return `<pre${command ? ' data-prefix="$"' : ' data-tone="muted"'}><code>${body}</code></pre>`;
    })
    .join('');
}

/** The package managers of the install switch, bun first: its command is the default. */
export const PACKAGE_MANAGERS = [
  ['bun', 'bun add'],
  ['pnpm', 'pnpm add'],
  ['npm', 'npm install'],
  ['yarn', 'yarn add'],
];

/**
 * An install command for each package manager in one terminal, with a toggle group that picks the one shown
 * (site.css hides the others) and a copy button for the visible line. website/chrome.mjs keeps every install
 * switch on the page on the same package manager.
 */
export function installBlock(packages, { label = 'Package manager' } = {}) {
  const toggles = PACKAGE_MANAGERS.map(
    ([pm], i) =>
      `<button class="toggle" type="button" aria-pressed="${i === 0}" value="${pm}">${pm}</button>`,
  ).join('');
  const lines = PACKAGE_MANAGERS.map(
    ([pm, add]) =>
      `<pre data-prefix="$" data-pm="${pm}"><code>${highlight(`${add} ${packages}`, 'bash')[0]}</code></pre>`,
  ).join('');
  return `<div class="hs-install" data-install><div class="hs-install-bar"><div class="toggle-group" role="group" aria-label="${escape(label)}" data-type="single" data-size="sm" data-variant="outline">${toggles}</div><button class="btn hs-install-copy" type="button" data-variant="ghost" data-size="sm" data-copy-install>${COPY_ICON}<span data-msg="copy">Copy</span></button></div><div class="mockup-code hs-shiki" data-chrome="none">${lines}</div><span class="sr-only" role="status" data-copy-status></span></div>`;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescape = (text) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);
/** Strips the common leading indentation, so a sample can sit indented inside the page source. */
const dedent = (text) => {
  const lines = text.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
};

/**
 * The page source's code placeholders, expanded:
 * - `<pre data-code="js" data-file="search.js" data-id="usage-code">…</pre>` becomes a file-style code block;
 * - `<pre data-terminal="bash">$ command…</pre>` becomes the lines of the mockup-code window around it;
 * - `<div data-install="pkg …"></div>` becomes the package manager switch with its terminal.
 * The text inside a placeholder is HTML-escaped source; it is unescaped before highlighting.
 */
export function expandCode(html) {
  return html
    .replace(
      /<pre data-code="([a-z]*)"((?: data-[a-z]+="[^"]*")*)>([\s\S]*?)<\/pre>/g,
      (_, lang, attrs, body) => {
        const attr = (name) => new RegExp(` data-${name}="([^"]*)"`).exec(attrs)?.[1];
        return codeBlock(dedent(unescape(body)), lang, { file: attr('file'), id: attr('id') });
      },
    )
    .replace(/<pre data-terminal="([a-z]*)">([\s\S]*?)<\/pre>/g, (_, lang, body) =>
      terminalLines(dedent(unescape(body)), lang),
    )
    .replace(
      /<div data-install="([^"]+)"(?: data-label="([^"]*)")?><\/div>/g,
      (_, packages, label) => installBlock(packages, label ? { label } : {}),
    );
}
