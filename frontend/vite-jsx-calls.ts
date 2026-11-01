// Production build step: JSX calls as short local names. `react/jsx-runtime` is CommonJS, so the
// bundle spells each element `(0,j.jsx)(`, 4,600 times over; through these constants it is `a(`.
// The same functions run. The dev server and the prerender keep the plain import.
import type { Plugin } from 'vite';

const RUNTIME = 'react/jsx-runtime';
export const LOCAL_RUNTIME = '\0yoneda-jsx-runtime';
export const LOCAL_SOURCE = `import runtime from '${RUNTIME}';
export const { Fragment, jsx, jsxs } = runtime;
`;

export function shortJsxCalls(): Plugin {
  return {
    name: 'yoneda-short-jsx-calls',
    apply: 'build',
    enforce: 'pre',
    resolveId: (id, importer) =>
      id === RUNTIME && importer !== LOCAL_RUNTIME ? LOCAL_RUNTIME : null,
    load: (id) => (id === LOCAL_RUNTIME ? LOCAL_SOURCE : null),
  };
}
