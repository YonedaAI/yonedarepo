import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary, reloadAfterStaleChunk } from './components/AppErrorBoundary';
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

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
