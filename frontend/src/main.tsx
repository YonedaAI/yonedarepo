import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary, reloadAfterStaleChunk } from './components/AppErrorBoundary';
import { applyTheme, readTheme } from './features/shell/theme';
import './styles.css';

// Vite reports a failed dynamic import of a replaced chunk after a deploy.
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (reloadAfterStaleChunk(window.sessionStorage, () => window.location.reload()))
      event.preventDefault();
  } catch {
    // Storage can be unavailable; the error boundary still shows a reload action.
  }
});

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
