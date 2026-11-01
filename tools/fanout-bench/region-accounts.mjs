// A test account that belongs to a region. An account's authority starts where its first request
// came from and stays, so one signed up through a regional client's serving object lives in that
// region, and one signed up through the public path lives near the pinned Worker. Passwords are
// derived from the kit's, never stored, and each address is Resend's test inbox.
import { createHmac } from 'node:crypto';

export const passwordFrom = (kitPassword, name) => createHmac('sha256', kitPassword).update(`region-test-${name}`).digest('hex');
const addressOf = (name) => `delivered+${name}@resend.dev`;

/** What a kept answer must not leave behind in a record. */
export const clean = ({ value, cookie, ...row }) => row;

/** One account's requests through one regional client, the way `Session` sends them. */
export class RegionSession {
  constructor({ call, client, serve, cookie, name }) {
    Object.assign(this, { client, serve, cookie, name, send: call });
  }
  async raw(method, path, body) {
    const step = { label: 'account', method, path, keep: true, cookie: this.cookie, ...(body === undefined ? {} : { json: body }) };
    const answer = await this.send(this.client, { steps: [step], ...(this.serve && { serve: this.serve }) });
    const row = answer.failed ? { ok: false, status: 0, error: 'BENCH_CLIENT', message: answer.failed } : answer.results[0];
    return { status: row.status, ok: row.ok, body: row.value ?? {}, error: row.error, message: row.message };
  }
  async post(path, body = {}) {
    const answer = await this.raw('POST', path, body);
    if (!answer.ok) throw new Error(`POST ${path}: ${answer.status} ${answer.error} ${answer.message ?? ''}`);
    return answer.body;
  }
}

/** Signs `name` in, signing it up on first use: `{session, row}`, `row` the sign-in's timing. */
export async function regionAccount({ call, client, serve, name, kitPassword }) {
  const password = passwordFrom(kitPassword, name);
  const email = addressOf(name);
  const send = async (label, path, json) => {
    const answer = await call(client, { steps: [{ label, path, json, keep: true, keep_cookie: true }], ...(serve && { serve }) });
    return answer.failed ? { ok: false, status: 0, ms: 0, server: null, error: 'BENCH_CLIENT', message: answer.failed } : answer.results[0];
  };
  let row = await send('sign_in', '/api/auth/login', { username: email, password });
  if (row.status === 401) row = await send('sign_in', '/api/auth/signup', { email, password });
  if (!row.ok) throw new Error(`${name} could not sign in through ${client}: ${row.status} ${row.error} ${row.message ?? ''}`);
  const session = new RegionSession({ call, client, serve, cookie: row.cookie, name: row.value.username });
  return { session, row: clean(row) };
}
