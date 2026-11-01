// The one page-level empty state: a centred title, one or two plain sentences on how the first
// one appears, at most one action. No box, no command syntax. A section inside a page shows one
// `source-empty` line instead.
import type { ReactNode } from 'react';

export function EmptyState({
  title,
  level = 2,
  id,
  role,
  action,
  children,
}: {
  title: ReactNode;
  /** The title's heading level: 1 when the empty state is the whole page. */
  level?: 1 | 2;
  /** The title's id, for a section labelled by it. */
  id?: string;
  /** `status` or `alert` when the state changes under the reader. */
  role?: 'status' | 'alert';
  /** One link (`button-link`) or button. */
  action?: ReactNode;
  /** One or two plain sentences. */
  children?: ReactNode;
}) {
  const Title = level === 1 ? 'h1' : 'h2';
  return (
    <div className="empty-state" role={role}>
      <Title id={id}>{title}</Title>
      {children && <p>{children}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
