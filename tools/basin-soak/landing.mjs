// What counts as a landing, in one place: Basin SQL and the comparison with the repository's log
// must never disagree on it. A landing is a commit a batch landed, or a version that carried one
// change of its own: not the batch's own version, nor an import, ref move or ref delete, which
// change nothing a writer made.
export const LANDING_KINDS = ['commit', 'merge', 'revert', 'changeset'];
export const LANDING = `(event = 'merged' OR (event = 'land' AND merged_landings = 0 AND kind IN (${LANDING_KINDS.map((k) => `'${k}'`).join(', ')})))`;
