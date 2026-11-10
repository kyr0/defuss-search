/**
 * The playground's Worker: the modules a snippet may import, bundled, and the runner of website/playground-source.mjs.
 * A snippet runs here, off the page's thread, so a loop that never ends stalls only this Worker; the page
 * terminates it after five seconds (website/playground.mjs). Nothing here touches the network.
 * VERIFIED: make e2e runs a snippet that never ends and sees the timeout message.
 */
import * as lexicalsearch from 'defuss-lexicalsearch';
import * as de from 'defuss-lexicalsearch/de';
import * as en from 'defuss-lexicalsearch/en';
import * as root from 'defuss-search';
import * as indexing from 'defuss-search/indexing';
import * as lexical from 'defuss-search/lexical';
import * as strategies from 'defuss-search/strategies';
import { runSnippet } from './playground-source.mjs';

const MODULES = {
  'defuss-search': root,
  'defuss-search/strategies': strategies,
  'defuss-search/indexing': indexing,
  'defuss-search/lexical': lexical,
  'defuss-lexicalsearch': lexicalsearch,
  'defuss-lexicalsearch/en': en,
  'defuss-lexicalsearch/de': de,
};

self.onmessage = async ({ data }) => {
  self.postMessage({ id: data.id, ...(await runSnippet(data.code, MODULES)) });
};
self.postMessage({ ready: true, modules: Object.keys(MODULES) });
