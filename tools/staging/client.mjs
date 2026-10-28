// Shared plumbing for the staging real-world kit (tools/staging-realworld.mjs): credential
// files, HTTP sessions against the staging front Worker and platform, and the step recorder.
// Credentials are read from 0600 files and never printed, logged or passed as arguments.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.config/yonedarepo');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const b64 = (text) => Buffer.from(text).toString('base64');
export const requestId = (label) => `${label}-${randomBytes(12).toString('hex')}`;

/** KEY=value lines of a private file; refuses files other users can read. */
export function readEnvFile(name, { required = true } = {}) {
  const path = join(CONFIG_DIR, name);
  if (!existsSync(path)) {
    assert.ok(!required, `Missing ${path}`);
    return {};
  }
  assert.equal(statSync(path).mode & 0o077, 0, `${path} must be mode 0600`);
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

/** The kit account, created on first use. */
export function kitCredentials() {
  const name = 'staging-kit.env';
  const values = readEnvFile(name, { required: false });
  if (!values.KIT_USERNAME || !values.KIT_PASSWORD) {
    const path = join(CONFIG_DIR, name);
    const added = `KIT_USERNAME=kit${randomBytes(4).toString('hex')}\nKIT_PASSWORD=${randomBytes(24).toString('hex')}\n`;
    writeFileSync(path, added, { mode: 0o600, flag: existsSync(path) ? 'a' : 'wx' });
    chmodSync(path, 0o600);
    return kitCredentials();
  }
  return values;
}

/** Bearer or cookie session against one origin; every call is timed. */
export class Session {
  constructor(origin, { bearer, cookie } = {}) {
    this.origin = origin.replace(/\/$/, '');
    this.bearer = bearer;
    this.cookie = cookie;
  }
  headers(extra = {}) {
    return {
      'content-type': 'application/json',
      ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...extra,
    };
  }
  /** `{ status, ok, body, ms, headers }`; never throws on HTTP errors. */
  async raw(method, path, body, extra) {
    const started = performance.now();
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers: this.headers(extra),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, body: value, ms: performance.now() - started, headers: response.headers };
  }
  /** The response body, or an error carrying the API's code. */
  async call(method, path, body) {
    const result = await this.raw(method, path, body);
    if (!result.ok)
      throw Object.assign(new Error(`${method} ${path}: ${result.status} ${result.body?.error?.code ?? ''} ${result.body?.error?.message ?? ''}`), {
        code: result.body?.error?.code,
        status: result.status,
      });
    return result.body;
  }
  get = (path) => this.call('GET', path);
  post = (path, body = {}) => this.call('POST', path, body);
}

/** Signs the kit account in (signing up once); returns a cookie session. */
export async function accountSession(origin, username, password) {
  const anonymous = new Session(origin);
  let login = await anonymous.raw('POST', '/api/auth/login', { username, password });
  if (login.status === 401) login = await anonymous.raw('POST', '/api/auth/signup', { username, password });
  assert.equal(login.status, 200, `Kit sign-in failed: ${login.body?.error?.code ?? login.status}`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  return new Session(origin, { cookie });
}

/** Polls `probe` until it returns a truthy value or the deadline passes. */
export async function until(probe, { timeoutMs, intervalMs = 3000, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** Records pass / fail / skip per item with timings and free-form metrics. */
export class Recorder {
  items = [];
  async step(id, title, run) {
    const started = performance.now();
    const item = { id, title, status: 'pass', ms: 0, metrics: {} };
    this.items.push(item);
    process.stdout.write(`… ${id} ${title}\n`);
    try {
      const outcome = await run(item.metrics);
      if (outcome?.skip) Object.assign(item, { status: 'skip', reason: outcome.skip });
    } catch (error) {
      Object.assign(item, { status: 'fail', reason: String(error?.message ?? error).slice(0, 400) });
    }
    item.ms = Math.round(performance.now() - started);
    process.stdout.write(`${item.status.toUpperCase()} ${id} ${item.ms}ms${item.reason ? ` (${item.reason})` : ''}\n`);
    return item;
  }
  table() {
    const rows = this.items.map((i) => `| ${i.id} | ${i.title} | ${i.status.toUpperCase()} | ${(i.ms / 1000).toFixed(1)} s | ${i.reason ?? summary(i.metrics)} |`);
    return ['| # | Item | Result | Time | Notes |', '|---|---|---|---|---|', ...rows].join('\n');
  }
}
const summary = (metrics) =>
  Object.entries(metrics)
    .filter(([, v]) => v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
