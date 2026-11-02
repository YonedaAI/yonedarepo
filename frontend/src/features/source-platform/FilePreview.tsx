// A Markdown file reads rendered, with its source a click away. A search result's link names a
// line, so it opens on the source, where that line can be marked.

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

export function PreviewToggle({
  preview,
  onChange,
}: {
  preview: boolean;
  onChange: (preview: boolean) => void;
}) {
  return (
    <fieldset className="segmented">
      <legend className="sr-only">Show</legend>
      <button type="button" aria-pressed={!preview} onClick={() => onChange(false)}>
        Code
      </button>
      <button type="button" aria-pressed={preview} onClick={() => onChange(true)}>
        Preview
      </button>
    </fieldset>
  );
}
