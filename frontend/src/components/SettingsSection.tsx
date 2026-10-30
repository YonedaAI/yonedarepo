// The account settings pages' shapes: a heading above a card, and a card of rows, each its text
// on the left and one action on the right, a thin rule between them. Rows wrap at phone width.
import type { ReactNode } from 'react';

export function SettingsSection({
  id,
  title,
  children,
}: {
  /** Names the section: its heading is `<id>-heading`. */
  id: string;
  title: string;
  children: ReactNode;
}) {
  const heading = `${id}-heading`;
  return (
    <section className="settings-section" aria-labelledby={heading}>
      <h2 id={heading}>{title}</h2>
      <div className="settings-card">{children}</div>
    </section>
  );
}

export function SettingsRow({
  media,
  title,
  detail,
  action,
}: {
  /** An avatar or a provider's mark, before the text. */
  media?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="settings-row">
      {media}
      <div className="settings-row-text">
        <div className="settings-row-title">{title}</div>
        {detail && <div className="source-meta">{detail}</div>}
      </div>
      {action && <div className="settings-row-action">{action}</div>}
    </div>
  );
}
