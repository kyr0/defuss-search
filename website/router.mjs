/**
 * Section routes with defuss-dom-router: `#/{id}` names a section or heading of the page, `#/` the top. Links with
 * `data-router-link` (the navigation, the heading anchors) navigate through the router, so Back and Forward walk the
 * sections a reader visited and every address is a deep link.
 * Why hash mode: GitHub Pages serves one file per path and has no fallback for deep paths, so a clean path such as
 * /recall would answer 404 on reload. Why `scroll: 'manual'`: the page scrolls to the section itself (its own glide
 * from a click, an instant jump when it opens on an address); the router's scroll to the top would stop that.
 * An address from before the routes (`#recall`) is rewritten to its route on load, so old links still land.
 * VERIFIED: make e2e walks the navigation routes, Back and Forward, and a legacy #recall address.
 */
import { createRouter } from 'defuss-dom-router';

const ROUTES = [
  { id: 'home', path: '/' },
  { id: 'section', path: '/:section' },
  { id: 'missing', path: '*' },
];
/** Sections a route may name under an earlier id. */
const ALIASES = { intro: 'top', frontier: 'pareto' };

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Starts the router; resolves with its first navigation's outcome. */
export async function initRouter() {
  const legacy = /^#([\w-]+)$/.exec(location.hash);
  if (legacy && document.getElementById(ALIASES[legacy[1]] ?? legacy[1]))
    history.replaceState(history.state, '', `#/${legacy[1]}`);
  let first = true;
  const links = () => document.querySelectorAll('.mk-header-nav a[data-router-link], .mk-header-sheet-nav a[data-router-link]');
  const show = (to) => {
    const id = to.routeId === 'section' ? (ALIASES[to.params.section] ?? to.params.section) : null;
    const target = id ? document.getElementById(id) : null;
    for (const link of links()) {
      if (id && link.getAttribute('href') === `#/${to.params.section}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
    // The page opens where its address says at once; a click glides there, unless the reader asked for less motion.
    const behavior = first || reducedMotion() ? 'instant' : 'smooth';
    const go = () => {
      if (target) {
        target.scrollIntoView({ behavior, block: 'start' });
        // A followed link moves the focus with the view, so the keyboard and a screen reader continue there.
        if (!first) {
          const heading = target.matches('h1, h2, h3, h4') ? target : target.querySelector('h1, h2, h3');
          if (heading) {
            if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
            heading.focus({ preventScroll: true });
          }
        }
      } else if (!first) scrollTo({ top: 0, behavior });
    };
    // Images and fonts move the sections while the page loads; a first jump waits for the load to land exactly.
    if (first && target && document.readyState !== 'complete') addEventListener('load', go, { once: true });
    else go();
    first = false;
  };
  const router = createRouter({
    mode: 'hash',
    scroll: 'manual',
    routes: ROUTES,
    prepare: ({ to }) => ({ commit: () => show(to) }),
  });
  router.attachLinks(document);
  // The router leaves a link to the address it is on unchanged, so a second click on "Playground" after scrolling
  // away did nothing; render() runs the same commit, which scrolls back to the section.
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[data-router-link]') : null;
    const plain = event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
    if (link && plain && link.getAttribute('href') === location.hash) router.render();
  });
  return router.start();
}
