// The code area and its loader: CodeMirror's chunk loads the first time a file is on screen, so
// nothing else pays for it, and until then the text stands plain in the same place.
import { lazy, Suspense } from 'react';
import type { CodeCommands, CodeSurfaceProps } from './CodeSurface';
import { FileText } from './FileText';
import { PLAIN_BYTES } from './fileFacts';
import { Loading } from './SourceStatus';

const CodeSurface = lazy(() => import('./CodeSurface'));

export type { CodeCommands };

export function CodeBlock(props: CodeSurfaceProps) {
  const { value, line, onChange } = props;
  const fallback = onChange ? (
    <textarea
      className="code-surface-plain"
      aria-label={props.label}
      value={value}
      rows={14}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  ) : value.length > PLAIN_BYTES ? (
    <Loading what="file" />
  ) : (
    <FileText content={value} line={line} />
  );
  return (
    <Suspense fallback={fallback}>
      <CodeSurface {...props} />
    </Suspense>
  );
}
