// A file's one header row: what it is on the left, what can be done with it on the right.
import { Check, Copy, FileCode2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { fileSize } from './fileFacts';

/** A copy action that says it worked. */
export function CopyButton({
  text,
  label,
  children,
}: {
  text: string;
  label: string;
  /** Words on the button; none, it is an icon. */
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      className={children ? 'quiet' : 'quiet file-icon-button'}
      aria-label={copied ? 'Copied' : label}
      title={label}
      onClick={() => void copy()}
    >
      <Icon size={14} aria-hidden="true" />
      {children && (copied ? 'Copied' : children)}
    </button>
  );
}

export function FileHeader({
  path,
  size,
  executable = false,
  children,
}: {
  path: string;
  /** Not yet known for a new file. */
  size?: number;
  executable?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="file-header">
      <span className="file-title">
        <FileCode2 size={16} aria-hidden="true" />
        <code title={path}>{path}</code>
        {size !== undefined && (
          <span className="source-meta file-size">
            {fileSize(size)}
            {executable ? ' · executable' : ''}
          </span>
        )}
        <CopyButton text={path} label="Copy path" />
      </span>
      {children && <span className="file-actions">{children}</span>}
    </header>
  );
}
