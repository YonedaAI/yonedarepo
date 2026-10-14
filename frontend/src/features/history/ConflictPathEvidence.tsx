import { ConflictPathList, type ConflictPathTarget } from './ConflictPathList';
import type { ConflictInventoryItem, ConflictOverlapItem } from './conflictInventory';
import { conflictPathSections } from './conflictPaths';

const labels = {
  conflict_paths: 'Affected paths',
  declared_paths: 'Declared repair scope',
  merged_paths: 'Merged paths',
  captured_paths: 'Captured changed paths',
  intervening_paths: 'Intervening paths',
  overlapping_paths: 'Overlapping paths',
};
export function ConflictPathEvidence({
  repo,
  record,
}: {
  repo: string;
  record: ConflictInventoryItem;
}) {
  return (
    <div>
      {conflictPathSections.map((section) => {
        const paths = record.path_sets[section];
        if (section !== 'conflict_paths' && paths.state === 'unknown') return null;
        const target: ConflictPathTarget | undefined = record.conflict_id
          ? { kind: 'conflict', id: record.conflict_id, section }
          : record.kind === 'stale_candidate' && section === 'captured_paths'
            ? { kind: 'candidate', id: record.candidate_id }
            : undefined;
        return (
          <ConflictPathList
            key={`${record.key}:${section}:${paths.state === 'paged' ? paths.reference.digest : 'inline'}`}
            repo={repo}
            label={labels[section]}
            paths={paths}
            target={target}
          />
        );
      })}
    </div>
  );
}
export function ConflictOverlapEvidence({
  repo,
  overlap,
}: {
  repo: string;
  overlap: ConflictOverlapItem;
}) {
  return (
    <>
      {overlap.status === 'not_analyzed' && (
        <p>Overlap has not been analyzed. No overlap conclusion is recorded.</p>
      )}
      <ConflictPathList
        key={`${overlap.key}:${overlap.path_set.state}`}
        repo={repo}
        label="Overlapping paths"
        paths={overlap.path_set}
        target={
          overlap.conflict_id
            ? { kind: 'conflict', id: overlap.conflict_id, section: 'overlapping_paths' }
            : undefined
        }
      />
    </>
  );
}
