/**
 * Page chrome shared with the sibling sites: the theme switch and the copy buttons, on the main page and the
 * rendered Markdown pages. The theme key and its JSON value match defuss-lexicalsearch and
 * defuss-vectorsearch, so the inline head script reads either.
 * VERIFIED: e2e toggles the theme and reads the clipboard after both copy buttons (session 2026-11-01).
 */
export function initChrome() {
  const toggle = document.querySelector('#theme-toggle');
  if (toggle) {
    const setTheme = (dark) => {
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
      toggle.checked = dark;
      try {
        localStorage.setItem('defuss-shadcn-theme', JSON.stringify(dark ? 'dark' : 'light'));
      } catch {
        /* Storage may be disabled; the switch still works for this page. */
      }
    };
    toggle.checked = document.documentElement.classList.contains('dark');
    toggle.addEventListener('change', () => setTheme(toggle.checked));
  }

  const copy = async (text, status, label, idle) => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied';
    } catch {
      status.textContent = 'Copy failed';
    }
    if (!label) return;
    label.textContent = status.textContent;
    setTimeout(() => (label.textContent = idle), 2000);
  };
  for (const block of document.querySelectorAll('.mk-code-block'))
    block
      .querySelector('.mk-code-block-copy')
      .addEventListener('click', () =>
        copy(block.querySelector('code').innerText, block.querySelector('.mk-code-block-status')),
      );
  const prompt = document.querySelector('#copy-prompt');
  prompt?.addEventListener('click', () =>
    copy(
      [...document.querySelectorAll('#agent-prompt pre:not([data-tone]) code')]
        .map((code) => code.textContent)
        .join('\n'),
      document.querySelector('#copy-prompt-status'),
      prompt.querySelector('span'),
      'Copy prompt',
    ),
  );
}
