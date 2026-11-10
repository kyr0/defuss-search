/**
 * Entry of the rendered Markdown pages (reference, frontier): the language of their header and footer, the theme
 * switch, the copy buttons and the section routes, without the main page's workers. VERIFIED: e2e opens both pages
 * without console errors.
 */
import { initChrome } from './chrome.mjs';
import { initI18n } from './i18n.mjs';
import { initRouter } from './router.mjs';

initI18n(document.body);
initChrome();
window.routerStart = await initRouter();
