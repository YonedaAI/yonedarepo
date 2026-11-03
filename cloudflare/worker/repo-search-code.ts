// Exact-revision code scanning. Ranking and bounds are unchanged; callers own admission
// and combining mutable search groups with this immutable result.
import { compute } from './repo-compute';
import { keepAllowed } from './repo-grants';
import { blobWaves } from './repo-object-waves';
import { toBase64 } from './repo-objects';
import type { Json, RepoContext } from './repo-ops';
import { searchSegments, segmentsIn } from './repo-search-index';
import { timed } from './repo-timing';

const MAX_RESULTS = 200;
const GREP_WAVE = 128;
const SKIPPED_LISTED = 50;

/** Result tiers, best first: the query as a whole word in the content, in the path, or
 * only inside longer words. */
const TIERS = ['word', 'path', 'substring'];
/** Candidate files read and ranked per search, and lines listed per file. */
const SCAN_FILES = 1000;
const SHOWN_LINES = 20;

/** Whether `path` holds `query` (as a whole word, with `word`). */
function inPath(path: string, query: string, ignoreCase: boolean, word: boolean) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = word ? `(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)` : escaped;
  return new RegExp(pattern, ignoreCase ? 'i' : '').test(path);
}

/** A file's tier (see TIERS) from its matches, or null when it does not match. */
function matchOf(path: string, query: string, found: Json, ignoreCase: boolean, word: boolean) {
  if (found.word_hits > 0) return 'word';
  if (inPath(path, query, ignoreCase, word)) return 'path';
  return !word && found.hits > 0 ? 'substring' : null;
}

export async function searchCode(ctx: RepoContext, args: Json, query: string, where: Json) {
  const { indexes, built } = await searchSegments(ctx, where.tree);
  const objects = await ctx.objects();
  const prefix = String(args.path ?? '');
  const limit = Math.min(Number(args.limit ?? 50) || 50, MAX_RESULTS);
  const results: Json[] = [];
  // Files whose content is not searched (too large, binary), and why.
  const skipped: Json[] = [];
  let skippedCount = 0;
  const under = (path: unknown) => !prefix || String(path).startsWith(prefix);
  // Candidates of every partition first (grants filter them before any content is read or
  // counted), then their files a wave at a time in a few ranged reads, in order, until the
  // limit: read one by one, each file waited on its own walk down the read tiers.
  const files: Json[] = [];
  for (const index of indexes)
    if (index.refused) {
      skippedCount++;
      skipped.push({ path: index.partition.prefix || '/', reason: index.refused });
    }
  for await (const { partition, segment } of segmentsIn(ctx, indexes)) {
    const { candidates, unindexed } = compute({
      op: 'search_segment',
      segment_b64: toBase64(segment),
      prefix: partition.prefix,
      query,
    });
    for (const file of await keepAllowed(
      ctx,
      (unindexed as Json[]).filter((f) => under(f.path)),
    )) {
      skippedCount++;
      if (skipped.length < SKIPPED_LISTED) skipped.push(file);
    }
    for (const file of await keepAllowed(ctx, candidates as Json[]))
      if (under(file.path)) files.push(file);
  }
  // Every candidate up to SCAN_FILES is read and ranked before the best `limit` are kept
  // (in segment order, the first `limit` found were A→Z by path, whatever they held).
  const ignoreCase = args.ignore_case === true || args.ignore_case === 'true';
  const word = args.word === true || args.word === 'true';
  const scan = files.slice(0, SCAN_FILES);
  for (let i = 0; i < scan.length; i += GREP_WAVE) {
    const wave = scan.slice(i, i + GREP_WAVE);
    const content = new Map<string, Uint8Array>();
    const indexed = wave.filter((f) => f.indexed).map((f) => String(f.id));
    await timed('search.files', async () => {
      for await (const read of blobWaves(objects, indexed))
        for (const [id, data] of read) content.set(id, data);
    });
    for (const file of wave) {
      const data = content.get(file.id);
      const found = data
        ? compute({
            op: 'grep',
            id: file.id,
            query,
            ignore_case: ignoreCase,
            word,
            max: SHOWN_LINES,
            blobs: { [file.id]: toBase64(data) },
          })
        : { lines: [], hits: 0, word_hits: 0 };
      const match = matchOf(String(file.path), query, found, ignoreCase, word);
      if (match)
        results.push({ path: file.path, id: file.id, match, hits: found.hits, lines: found.lines });
    }
  }
  results.sort(
    (a, b) =>
      TIERS.indexOf(a.match) - TIERS.indexOf(b.match) ||
      b.hits - a.hits ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return {
    // A refused partition is an incomplete scan, even though the API names its skipped
    // paths with HTTP 200. A later request must retry rather than retain that refusal.
    reusable: indexes.every((index) => !index.refused),
    value: {
      commit: where.commit,
      results: results.slice(0, limit),
      truncated: files.length > SCAN_FILES,
      partitions_built: built,
      skipped_files: skipped,
      skipped_count: skippedCount,
    },
  };
}
