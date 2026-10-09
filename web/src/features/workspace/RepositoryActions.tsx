import { Ellipsis, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import type { Repository } from '../../lib/types';

export function RepositoryActions({
  repository,
  onDelete,
}: {
  repository: Repository;
  onDelete: (repository: Repository) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  return (
    <details className="repository-actions" ref={menu}>
      <summary aria-label={`Repository options for ${repository.name}`} title="Repository options">
        <Ellipsis size={19} aria-hidden="true" />
      </summary>
      <div className="repository-action-menu">
        <button
          type="button"
          onClick={() => {
            if (menu.current) {
              menu.current.open = false;
              menu.current.querySelector('summary')?.focus();
            }
            onDelete(repository);
          }}
        >
          <Trash2 size={15} />
          Delete repository
        </button>
      </div>
    </details>
  );
}
