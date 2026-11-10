/**
 * Entry of the main page. The language binds first, so a German reader's page is German before anything else
 * paints; the router starts last, once every section it may scroll to exists. VERIFIED: the static sections work
 * before, and without, these scripts; scripts/e2e.mjs drives each part in Chromium.
 */
import { initCharts } from './charts.mjs';
import { initChrome } from './chrome.mjs';
import { initDemo } from './demo.mjs';
import { initI18n } from './i18n.mjs';
import { initPlayground } from './playground.mjs';
import { initRouter } from './router.mjs';

initI18n(document.body);
initChrome();
initDemo();
initPlayground();
initCharts();
window.routerStart = await initRouter();
