import { lazy, StrictMode, Suspense } from 'react';
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

// The source platform is its own feature area; the workspace (agent layer) stays at `/`.
const SourceApp = lazy(() =>
  import('./features/source-platform/SourceApp').then((m) => ({ default: m.SourceApp })),
);
// `/device` (approving `yoneda login`) belongs to the source platform too.
const source =
  window.location.pathname === '/source' ||
  window.location.pathname.startsWith('/source/') ||
  window.location.pathname === '/device';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      {source ? (
        <Suspense fallback={null}>
          <SourceApp />
        </Suspense>
      ) : (
        <App />
      )}
    </AppErrorBoundary>
  </StrictMode>,
);
