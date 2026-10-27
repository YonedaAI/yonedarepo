// The repository's head holder (the land combiner class, named `<repo>#head`): it keeps the
// authority's latest `repo_head` answer for every isolate, so a commit begins and a read is
// authorized without an authority round trip. A landing or projection makes it stale and
// it reloads in the background; an access change reloads it before that change answers,
// so the access snapshot it serves is never older than the last change it was told of.
import { caller, type Json } from './repo-ops';
import type { Env } from './types';

/** The authority's head of main (a platform read; access is decided from its snapshot). */
export const fetchHead = (env: Env, repo: string) =>
  caller(env, repo, { _system: 'projection' })({ op: 'repo_head', ref: 'main' });

/** `head` without its access snapshot, and the snapshot alone. */
export const withoutTokens = ({ tokens: _, members: __, ...head }: Json) => head;
export const accessOf = (head: Json) => ({
  version: head.access_version,
  tokens: head.tokens,
  members: head.members ?? [],
});

/** The head holder's state, refreshed from the authority one call at a time. */
export class HeadHolder {
  #head: Json | null = null;
  #stale = true;
  #loading: Promise<Json> | null = null;
  /** Bumped by an access change: loads started before it never set the head. */
  #generation = 0;

  constructor(private readonly env: Env) {}

  /** The head it holds when that is recent enough for the caller (a stale one is
   * refreshed in the background: begins validate their base when they land); otherwise
   * waits for a load that reaches `minVersion`. With the caller's `accessVersion` (null
   * when it holds none), the access snapshot travels too whenever the caller's differs. */
  async head(
    repo: string,
    minVersion: number,
    since?: number,
    accessVersion?: string | null,
  ): Promise<Json> {
    let head = this.#head;
    if (head && head.version >= minVersion) {
      if (this.#stale) void this.#load(repo, 0).catch(() => {});
    } else head = await this.#load(repo, minVersion);
    const access =
      accessVersion !== undefined && accessVersion !== head.access_version
        ? { access: accessOf(head) }
        : {};
    // A caller holding a copy at `since` gets only the overlay entries newer than it.
    if (since === undefined) return { ...withoutTokens(head), ...access };
    return {
      ...withoutTokens(head),
      overlay: (head.overlay as Json[]).filter((e) => e.version > since),
      overlay_since: since,
      ...access,
    };
  }

  async access(repo: string): Promise<Json> {
    return accessOf(this.#head ?? (await this.#load(repo, 0)));
  }

  /** Marks the head stale. After a landing or projection it reloads in the background.
   * After an access change (`access`) it drops the head it held, lets no load started
   * before the change set it again, and answers once a fresh load has it; if that load
   * fails, nothing is served until one succeeds. */
  async refresh(repo: string, access = false) {
    this.#stale = true;
    if (!access) {
      void this.#load(repo, 0).catch(() => {});
      return;
    }
    this.#generation++;
    this.#head = null;
    this.#loading = null;
    // A deleted repository has no head to serve; that is the refresh it needed.
    await this.#load(repo, 0).catch((e) => {
      if (e?.code !== 'GONE') throw e;
    });
  }

  /** Settles once no load is running (tests stop in-process holders with it). */
  async idle() {
    while (this.#loading) await this.#loading.catch(() => {});
  }

  async #load(repo: string, minVersion: number): Promise<Json> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A load already running may have started before the version this caller needs.
      this.#loading ??= this.#fetch(repo);
      const head = await this.#loading;
      if (head.version >= minVersion) return head;
    }
    return this.#head as Json;
  }

  #fetch(repo: string): Promise<Json> {
    const generation = this.#generation;
    const current = () => generation === this.#generation;
    const loading: Promise<Json> = (async () => {
      this.#stale = false;
      const head = await fetchHead(this.env, repo).catch((e) => {
        // A deleted repository's head is never served again.
        if (e?.code === 'GONE' && current()) this.#head = null;
        throw e;
      });
      if (current()) this.#head = head;
      return head;
    })().finally(() => {
      if (this.#loading === loading) this.#loading = null;
    });
    return loading;
  }
}
