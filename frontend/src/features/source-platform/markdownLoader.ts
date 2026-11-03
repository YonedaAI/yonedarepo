// The parser stays lazy on unrelated pages; Overview can overlap it with its data reads.
let loading: Promise<typeof import('./GfmDocument')> | undefined;
export function loadRichMarkdown() {
  loading ??= import('./GfmDocument').catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
export function preloadOverviewMarkdown() {
  if (import.meta.env.VITE_OVERVIEW_MARKDOWN_PRELOAD === 'on')
    void loadRichMarkdown().catch(() => {});
}
