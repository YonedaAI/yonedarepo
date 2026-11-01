// One session's person or agent: its region, credential and repository. `step` sends through the
// region's client and records what came back; `think` waits as they would, and ends at once when
// the run is stopping, so a session never outlives its run by more than one request.
import { sample } from '../fanout-bench/region-matrix.mjs';

const REQUEST_OUTLIVES_ANSWER = (answer, steps) => answer.failed ? steps.map((s) => ({ label: s.label, started_at: Date.now(), status: 0, ok: false, ms: 0, server: null, timing: '', error: 'BENCH_CLIENT', message: answer.failed })) : answer.results;

export class Actor {
  constructor({ run, kind, region, who, person, repo, random, assets, target, cookie, credential, reviewer }) {
    Object.assign(this, { run, kind, region, who, person, repo, random, assets, target, cookie, credential, reviewer });
    this.api = `/api/v1/repos/${repo.id}`;
  }
  #sign(s) {
    if (s.reviewer) return { ...s, reviewer: undefined, cookie: this.reviewer };
    return this.cookie && !s.path.startsWith('/git/') ? { ...s, cookie: this.cookie } : { ...s, token: s.token ?? this.credential };
  }
  async #send(steps, parallel) {
    const signed = steps.map((s) => this.#sign(s));
    const answer = await this.run.send(this.region, this.target, signed, parallel);
    const rows = REQUEST_OUTLIVES_ANSWER(answer, signed);
    for (const row of rows) this.run.note({ ...sample(row), kind: this.kind, region: this.region, who: this.who });
    return rows;
  }
  /** One request; its answer (with `value` when the step asked to `keep` it). */
  async step(s) {
    return (await this.#send([s], false))[0];
  }
  /** Requests in order, as one Git command sends them; at most 12. */
  steps(steps) {
    return this.#send(steps, false);
  }
  /** A page's requests, side by side: a browser's first paint needs them all. */
  page(steps) {
    return this.#send(steps, true);
  }
  think(low, high) {
    return this.run.wait((low + this.random() * (high - low)) * 1000);
  }
}
