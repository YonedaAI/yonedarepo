import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useMemo: (compute: () => unknown) => compute(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] = value;
      },
    ];
  },
}));

import { SourceDiff } from './SourceDiff';

const diff =
  'diff --git a/src/search.js b/src/search.js\nindex aa..bb 100644\n--- a/src/search.js\n+++ b/src/search.js\n@@ -10,2 +10,3 @@\n const query = input.trim();\n-return raw(query);\n+return normalized(query);\n+// preserve accents\ndiff --git a/tests/search.js b/tests/search.js\nnew file mode 100644\n--- /dev/null\n+++ b/tests/search.js\n@@ -0,0 +1,2 @@\n+assertSearch("café");\n+assertSearch("");';
function render(value = diff) {
  hooks.cursor = 0;
  return SourceDiff({ diff: value });
}
function find(
  node: ReactNode,
  type: string,
  label: string,
): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((item) => find(item, type, label)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const item = node as ReactElement<Record<string, any>>;
  if (item.type === type && renderToStaticMarkup(item).includes(label)) return item;
  return find(item.props.children, type, label);
}
beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
});
describe('captured patch review', () => {
  it('lists every changed file but displays only the selected patch with old and new line numbers', () => {
    const html = renderToStaticMarkup(render());
    expect(html).toContain('Changed files');
    expect(html).toContain('src/search.js');
    expect(html).toContain('tests/search.js');
    expect(html).toContain('normalized(query)');
    expect(html).not.toContain('assertSearch');
    expect(html).toContain('Old line 11</span>');
    expect(html).toContain('New line 12</span>');
  });
  it('navigates through multiple files and resets the selection when the captured patch changes', () => {
    const tree = render();
    const next = find(tree, 'button', 'Next file');
    expect(next).toBeDefined();
    next?.props.onClick();
    expect(renderToStaticMarkup(render())).toContain('assertSearch');
    expect(renderToStaticMarkup(render())).not.toContain('normalized(query)');
    const different = diff
      .replaceAll('src/search.js', 'src/other.js')
      .split('diff --git a/tests')[0];
    expect(renderToStaticMarkup(render(different))).toContain('src/other.js');
    expect(renderToStaticMarkup(render(different))).not.toContain('assertSearch');
  });
  it('makes binary and renamed changes visible without inventing text or hiding paths', () => {
    const binary =
      'diff --git "a/old name.png" "b/new name.png"\nsimilarity index 100%\nrename from old name.png\nrename to new name.png\nBinary files a/old name.png and b/new name.png differ';
    const html = renderToStaticMarkup(createElement(SourceDiff, { diff: binary }));
    expect(html).toContain('new name.png');
    expect(html).toContain('old name.png');
    expect(html).toContain('Binary');
    expect(html).not.toContain('No source changes');
  });
});
