import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary, reloadAfterStaleChunk } from './components/AppErrorBoundary';
import { applyTheme, readTheme } from './features/shell/theme';
import { reportClientError } from './features/site/clientErrors';
import { rememberLanding, tabStorage } from './features/site/landingSource';
import { sendPagePing } from './features/site/pagePing';
import './styles.css';

// How the reader last moved: base.css keeps a select's focus ring for the keyboard only.
const html = document.documentElement;
document.addEventListener('pointerdown', () => html.setAttribute('data-pointer', ''), true);
document.addEventListener('keydown', () => html.removeAttribute('data-pointer'), true);

// Vite reports a failed dynamic import of a replaced chunk after a deploy.
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (reloadAfterStaleChunk(window.sessionStorage, () => window.location.reload()))
      event.preventDefault();
  } catch {
    // Storage can be unavailable; the error boundary still shows a reload action.
  }
});

// What React's boundary never sees: an error thrown outside a render.
window.addEventListener('error', (event) => {
  if (event.error) void reportClientError(event.error);
});

// Where this tab's visitor came from, for counting sign-ups by source (no cookie).
rememberLanding(tabStorage(), window.location.href, document.referrer);

// index.html's inline script already set the theme before the first paint; this keeps a
// stale attribute from surviving a choice made in another tab before load.
applyTheme(readTheme());

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);

// Once per page load, after it: a scanner that never runs JavaScript sends nothing.
const ping = () =>
  sendPagePing({
    location: window.location,
    referrer: document.referrer,
    sendBeacon: (url, data) => navigator.sendBeacon(url, data),
  });
if (document.readyState === 'complete') ping();
else window.addEventListener('load', ping, { once: true });
