/**
 * Shiki in the browser, for the playground only: its editor colours the code as you type and its console colours
 * what a snippet prints. A fine-grained build (JavaScript grammar, the AA themes of shiki-themes.mjs, the JavaScript
 * regex engine) of about 74 KB gzipped, loaded the first time the playground comes near the viewport. The rest of
 * the page was highlighted at build time with the same themes (scripts/highlight.mjs).
 * VERIFIED: make e2e edits and runs a playground snippet with this highlighter in Chromium.
 */
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import javascript from '@shikijs/langs/javascript';
import { DARK, LIGHT, THEMES } from './shiki-themes.mjs';

const highlighter = await createHighlighterCore({
  themes: [LIGHT, DARK],
  langs: [javascript],
  engine: createJavaScriptRegexEngine(),
});
const escape = (text) => text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);

/**
 * The HTML of coloured spans for one source, in `prefix` custom properties: `--code-example` for the editor's paint
 * layer (code-example.css), `--shiki` for console lines (site.css). One line of HTML per source line.
 */
export function highlightLines(code, prefix = '--shiki') {
  const { tokens } = highlighter.codeToTokens(code, {
    lang: 'javascript',
    themes: THEMES,
    defaultColor: false,
    cssVariablePrefix: `${prefix}-`,
  });
  return tokens.map((line) =>
    line
      .map((token) => {
        const style = Object.entries(token.htmlStyle ?? {})
          .map(([key, value]) => `${key}:${value}`)
          .join(';');
        return style ? `<span style="${style}">${escape(token.content)}</span>` : escape(token.content);
      })
      .join(''),
  );
}
