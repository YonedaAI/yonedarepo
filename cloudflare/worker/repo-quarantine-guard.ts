// Quarantine as reads meet it (the authority decides: repo_store/quarantine.rs). Every
// access answer lists the blobs no read serves; the object layer (repo-objects) refuses
// them before asking any tier, and jobs that derive data from content (search, seeds)
// leave them out. Kept free of imports so the object layer can use it.

/** Withheld blobs by id, with the path the owner named (null when none was given). */
export type Withheld = Map<string, string | null>;

/** The withheld map of an access answer's `quarantined` (`[{id, path}]`). */
export function withheldMap(list: unknown): Withheld {
  const map: Withheld = new Map();
  if (!Array.isArray(list)) return map;
  for (const entry of list)
    if (typeof entry?.id === 'string')
      map.set(entry.id, typeof entry.path === 'string' ? entry.path : null);
  return map;
}

/** The refusal for withheld blob `id` (HTTP 451; Git prints it as a remote error). */
export function quarantined(id: string, path: string | null) {
  const where = path ? ` (${path})` : '';
  return Object.assign(
    new Error(
      `Blob ${id}${where} is quarantined by the repository's owner and is not served; ` +
        'a fetch that needs it cannot complete (a partial clone or sparse checkout without it can)',
    ),
    { code: 'QUARANTINED' },
  );
}
