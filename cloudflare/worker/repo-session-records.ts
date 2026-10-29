// Session records and the transcripts the platform keeps for them: the adapter half. The
// authority owns the records (repo_store/sessions.rs). A transcript is made ready in Rust
// next to this Worker (platform_transcript.rs: credentials redacted, fitted to 1 MiB), the
// record is checked by a dry run, the document is written to R2 under the repository's
// platform prefix (so the repository purge removes it) at a key named by its sha256 and
// read back, and only then is the record posted naming it. A record that fails after the
// write leaves a document nothing names; posting again writes the same key.
import { compute } from './repo-compute';
import { ApiError, type Json, type RepoContext } from './repo-ops';

/** A session record's request body: the CLI fits a transcript to 3 MiB before upload. */
export const SESSION_BODY_LIMIT = 4 * 1024 * 1024;

export const transcriptKey = (repo: string, sha256: string) =>
  `platform/v1/${repo}/sessions/transcripts/${sha256}.json`;

/** `git_session_record`: the record, and the transcript when one is given. */
export async function recordSession(ctx: RepoContext, a: Json): Promise<Json> {
  const record = {
    op: 'repo_session_record',
    commit: a.commit,
    cli: a.cli,
    summary: a.summary,
    model: a.model ?? null,
    prompt_digest: a.prompt_digest ?? null,
    transcript_ref: a.transcript_ref ?? null,
    read_set_digest: a.read_set_digest ?? null,
    session_id: a.session_id ?? null,
  };
  if (a.transcript === undefined || a.transcript === null) return ctx.call(record);
  const { document, transcript } = compute({ op: 'session_transcript', transcript: a.transcript });
  const full = { ...record, transcript };
  // Refused before anything is written: not the pusher, a bad field, the commit's cap. A
  // record already kept answers as it is, with nothing uploaded again.
  const checked = await ctx.call({ ...full, dry_run: true });
  if (checked.already) return checked;
  const key = transcriptKey(ctx.repo, transcript.sha256);
  await ctx.env.OBJECTS.put(key, document, {
    sha256: transcript.sha256,
    httpMetadata: { contentType: 'application/json' },
  });
  const stored = await ctx.env.OBJECTS.head(key);
  if (stored?.size !== transcript.bytes)
    throw new ApiError('INTERNAL', 'The transcript was not stored; post the record again');
  return ctx.call(full);
}

/** `GET sessions/:id/transcript`: the stored document with its metadata. */
export async function readTranscript(ctx: RepoContext, id: number): Promise<Json> {
  const found = await ctx.call({ op: 'repo_session_transcript', id });
  const sha256 = found.transcript?.sha256;
  // The digest is the authority's, but never trust stored state for a key.
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
    throw new ApiError('NOT_FOUND', `Session ${id} has no stored transcript`);
  const object = await ctx.env.OBJECTS.get(transcriptKey(ctx.repo, sha256));
  if (!object)
    throw new ApiError('NOT_FOUND', `Session ${id}'s transcript is missing from storage`);
  return { session: found.session, transcript: found.transcript, document: await object.json() };
}
