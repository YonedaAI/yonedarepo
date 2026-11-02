// One file on the page: its header row, then its code, its Markdown read, or its blame. The
// code area reads the same as the editor, so that editing a file changes nothing but the caret.
import { useState } from 'react';
import type { Navigate } from '../shell/useRoute';
import { CodeBlock } from './CodeBlock';
import type { FileBody } from './codeData';
import { FileBlame } from './FileBlame';
import { CopyButton, FileHeader } from './FileHeader';
import { isMarkdown, PreviewToggle } from './FilePreview';
import { PLAIN_BYTES, showRaw } from './fileFacts';
import { RepoMarkdown } from './RepoMarkdown';

const isText = (file: FileBody) => file.encoding === 'utf-8';

export function FileView({
  file,
  path,
  line,
  place,
  onLine,
  onEdit,
  onNavigate,
}: {
  file: FileBody;
  path: string;
  line?: number;
  place: { repo: string; ref: string; path: string; at?: number };
  onLine: (line: number) => void;
  /** Present, the viewer may change this file. */
  onEdit?: () => void;
  onNavigate: Navigate;
}) {
  const [blaming, setBlaming] = useState(false);
  const [source, setSource] = useState(false);
  const text = isText(file);
  const previewable = text && file.size > 0 && !line && isMarkdown(path);
  const large = file.size > PLAIN_BYTES;
  return (
    <article className="source-file">
      <FileHeader path={path} size={file.size} executable={file.executable}>
        {previewable && !blaming && (
          <PreviewToggle preview={!source} onChange={(preview) => setSource(!preview)} />
        )}
        {text && file.size > 0 && (
          <CopyButton text={file.content} label="Copy contents">
            Copy contents
          </CopyButton>
        )}
        {onEdit && text && (
          <button type="button" className="quiet" onClick={onEdit}>
            Edit
          </button>
        )}
        {place.at === undefined && text && file.size > 0 && (
          <button
            type="button"
            className="quiet"
            aria-pressed={blaming}
            onClick={() => setBlaming((b) => !b)}
          >
            {blaming ? 'Hide blame' : 'Blame'}
          </button>
        )}
      </FileHeader>
      {!text ? (
        <p className="source-empty">Binary file not shown.</p>
      ) : file.size === 0 ? (
        <p className="source-empty">This file is empty.</p>
      ) : blaming && place.at === undefined ? (
        <FileBlame repo={place.repo} path={path} refName={place.ref} onNavigate={onNavigate} />
      ) : previewable && !source ? (
        <RepoMarkdown source={file.content} place={place} />
      ) : (
        <>
          {large && (
            <p className="file-note">
              Large file: no colors.
              <button type="button" onClick={() => showRaw(file.content)}>
                Show raw
              </button>
            </p>
          )}
          <CodeBlock
            key={`${path}:${file.commit}`}
            value={file.content}
            path={path}
            label={`Contents of ${path}`}
            line={line}
            onLine={onLine}
          />
        </>
      )}
    </article>
  );
}
