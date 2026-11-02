// Plumbing of kit item 48, the walk through every `yoneda` command (cli-walk-flow.mjs). A Person is
// one throwaway HOME: its own credentials, Git config and SSH directory, with nothing of this
// machine's in its environment. A Walk holds the people, the rows of the coverage table and what
// has to be cleaned up. A row fails when what the command did is not what it says it does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Session, until } from './client.mjs';
import { gitConfigEnv, OWN_TRAFFIC_ENV } from '../own-traffic.mjs';

export const ALL_SCOPES = ['repo:read', 'repo:write', 'repo:land', 'repo:review', 'repo:admin', 'account:ssh-keys'];
/** What the /device page ticks for a CLI login (frontend connect.ts DEVICE_PAT_SCOPES). */
export const DEVICE_SCOPES = ['repo:read', 'repo:write', 'repo:land', 'repo:admin', 'account:ssh-keys'];
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'];
const SECRET = /\b(ypat|yrp|yagt)_[A-Za-z0-9_-]{8,}/g;
const OPENER = '#!/bin/sh\nprintf "%s\\n" "$1" >> "$HOME/opened-urls"\n';
const CLIPBOARD = '#!/bin/sh\ncat >> "$HOME/clipboard"\n';
// OpenSSH finds ~ in the password database, not $HOME, so left alone it would read this machine's
// ~/.ssh. This one looks only in the throwaway HOME, as ssh does for a person in their own.
const SSH = '#!/bin/sh\nconfig=/dev/null\n[ -f "$HOME/.ssh/config" ] && config="$HOME/.ssh/config"\nexec /usr/bin/ssh -F "$config" -o "UserKnownHostsFile=$HOME/.ssh/known_hosts" -o "IdentityFile=$HOME/.ssh/id_ed25519" -o IdentitiesOnly=yes "$@"\n';

export const short = (text, length = 240) => (text.length > length ? `${text.slice(0, length)}...` : text);
const scrubbed = (text, secrets) => [...secrets].reduce((all, s) => all.split(s).join('[secret]'), text).replace(SECRET, '$1_[secret]');

/** One throwaway HOME. `walk` owns it; `bin` holds the yoneda under test. */
export class Person {
  constructor(walk, name, bin = walk.bin) {
    Object.assign(this, { walk, name, bin, home: join(walk.dir, name), token: null, patId: null });
    mkdirSync(join(this.home, 'bin'), { recursive: true });
    // `login` opens the browser and `ssh setup` fills the clipboard: these write it down instead,
    // so neither reaches this machine's. `ssh` stays inside this HOME.
    const stand_ins = { open: OPENER, 'xdg-open': OPENER, pbcopy: CLIPBOARD, 'wl-copy': CLIPBOARD, xclip: CLIPBOARD, xsel: CLIPBOARD, ssh: SSH };
    for (const [tool, script] of Object.entries(stand_ins)) {
      writeFileSync(join(this.home, 'bin', tool), script);
      chmodSync(join(this.home, 'bin', tool), 0o755);
    }
    writeFileSync(join(this.home, '.gitconfig'), `[user]\n\tname = ${name}\n\temail = ${name}@yonedarepo.invalid\n[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n[advice]\n\tdetachedHead = false\n`);
  }
  /** The only environment its processes see. */
  env(extra = {}) {
    return {
      PATH: [join(this.home, 'bin'), this.bin, ...this.walk.extraPath, ...SYSTEM_PATH].join(':'),
      HOME: this.home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C.UTF-8',
      ...OWN_TRAFFIC_ENV,
      ...gitConfigEnv({ origin: this.walk.api }),
      ...extra,
    };
  }
  path = (...parts) => join(this.home, ...parts);
  /** Runs a process to its end; never throws on exit status. Output comes back scrubbed. */
  exec(command, args, { cwd = this.home, env = this.env(), input, onOutput, raw = false } = {}) {
    const started = performance.now();
    return new Promise((done, fail) => {
      const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let [stdout, stderr] = ['', ''];
      const add = (which, chunk) => {
        if (which === 1) stdout += chunk;
        else stderr += chunk;
        onOutput?.(stdout + stderr, child);
      };
      child.stdout.on('data', (d) => add(1, d));
      child.stderr.on('data', (d) => add(2, d));
      child.on('error', fail);
      child.on('close', (code, signal) => {
        const clean = (text) => (raw ? text : scrubbed(text, this.walk.secrets)).trim();
        done({ code, signal, stdout: clean(stdout), stderr: clean(stderr), ms: Math.round(performance.now() - started) });
      });
      child.stdin.end(input ?? '');
    });
  }
  /** `yoneda args`, whatever it exits with. */
  y = (args, options) => this.exec(join(this.bin, 'yoneda'), args, options);
  /** `yoneda args`, which must exit 0. */
  async ok(args, options) {
    const ran = await this.y(args, options);
    assert.equal(ran.code, 0, `yoneda ${args.join(' ')} exited ${ran.code ?? ran.signal}: ${said(ran)}`);
    return ran;
  }
  /** `yoneda args --json`, which must exit 0 and print one document of its schema. */
  async j(args, options) {
    const ran = await this.ok([...args, '--json'], options);
    return this.walk.document(ran.stdout, args);
  }
  /** A refusal: `exit`, and a plain message matching `words`. */
  async refused(args, exit, words, options) {
    const ran = await this.y(args, options);
    assert.equal(ran.code, exit, `yoneda ${args.join(' ')} exited ${ran.code ?? ran.signal}, not ${exit}: ${said(ran)}`);
    assert.match(ran.stderr, words, `yoneda ${args.join(' ')} did not say so: ${said(ran)}`);
    plain(ran.stderr);
    return ran;
  }
  git = (cwd, ...args) => this.exec('git', args, { cwd });
  async gitOk(cwd, ...args) {
    const ran = await this.git(cwd, ...args);
    assert.equal(ran.code, 0, `git ${args.join(' ')} exited ${ran.code ?? ran.signal}: ${short(ran.stderr)}`);
    return ran.stdout;
  }
  /** Commits every change in `dir` with `files` written first; the new commit's id. */
  async commit(dir, files, message) {
    for (const [path, text] of Object.entries(files)) writeFile(join(dir, path), text);
    await this.gitOk(dir, 'add', '-A');
    await this.gitOk(dir, 'commit', '-q', '-m', message);
    return this.gitOk(dir, 'rev-parse', 'HEAD');
  }
  /** The platform API with this person's token. */
  get api() {
    return new Session(`${this.walk.api}/api/v1`, { bearer: this.token });
  }
  credentialsFile = () => this.path('.config', 'yoneda', 'credentials');
  /** Remembers the stored token, so it can be scrubbed, used and revoked. */
  remember() {
    const stored = JSON.parse(readFileSync(this.credentialsFile(), 'utf8'));
    this.token = stored.token;
    this.walk.secrets.add(stored.token);
    return stored;
  }
  /** `yoneda login args`, approved through the /device page's call with `approval`. */
  async device(args, approval, approver = this.walk.owner, env) {
    let settled;
    const shown = new Promise((resolve) => (settled = resolve));
    const running = this.y(['login', ...args, '--origin', this.walk.api], {
      env,
      onOutput: (text) => {
        const code = text.match(/enter the code ([A-Z]{4}-[A-Z]{4})/)?.[1];
        if (code) settled(code);
      },
    });
    running.then(() => settled(null));
    const code = await shown;
    if (!code) assert.fail(`yoneda login showed no code: ${short((await running).stderr)}`);
    const approved = await approver.post('/device/approve', { user_code: code, expires_days: 1, ...approval });
    assert.equal(approved.approved, true, 'the device approval was not recorded');
    const done = await running;
    assert.equal(done.code, 0, `yoneda login: ${short(done.stderr)}`);
    return done;
  }
  /** The real device login, with `scopes` ticked on the page. */
  async login({ args = ['--no-browser'], scopes = ALL_SCOPES, approver = this.walk.owner } = {}) {
    const done = await this.device(args, { scopes }, approver);
    this.remember();
    const { tokens } = await approver.get('/tokens');
    const mine = tokens.filter((t) => t.name === 'yoneda-cli').sort((a, b) => b.created_at - a.created_at)[0];
    assert.ok(mine, 'the login token is not listed under /tokens');
    this.patId = mine.id;
    this.walk.tokens.push({ session: approver, id: mine.id });
    return { done, token: mine };
  }
}

/** What a command said for itself: its --json error's words, else its output. */
function said(ran) {
  try {
    const { code, message } = JSON.parse(ran.stdout).data;
    if (message) return short(`${code}: ${message}`);
  } catch {
    // Not a JSON document: its text, below.
  }
  return short(ran.stderr || ran.stdout);
}

/** The file `path`, with its directories made. */
export function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** An error a person can read: no panic, no stack, no Rust debug text. */
export function plain(text) {
  assert.doesNotMatch(text, /panicked at|stack backtrace|RUST_BACKTRACE|Error \{|reqwest::/, `not a plain error: ${short(text)}`);
  assert.ok(text.trim().length > 0, 'it failed without saying why');
}

/** The coverage table's results, the people and what the run must clean up. */
export class Walk {
  constructor({ api, origin, bin, owner, root, table }) {
    Object.assign(this, { api: api.replace(/\/$/, ''), origin, bin, owner, root, table });
    this.dir = mkdtempSync(join(tmpdir(), 'yoneda-cli-walk-'));
    chmodSync(this.dir, 0o700);
    this.ts = Date.now();
    this.results = new Map();
    this.secrets = new Set();
    this.schemas = new Map();
    this.extraPath = [];
    this.tokens = [];
    this.repos = [];
    this.orgs = [];
    this.keys = [];
    this.people = [];
    this.defer = [];
  }
  person(name, bin) {
    const person = new Person(this, name, bin);
    this.people.push(person);
    return person;
  }
  /** A name for a throwaway repository or organization. */
  name = (what) => `cli-walk-${this.ts}-${what}`;
  anonymous = () => new Session(`${this.api}/api/v1`);
  /** Parses one `--json` document and checks it against its schema's required fields. */
  document(text, args) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      assert.fail(`yoneda ${args.join(' ')} --json is not one JSON document: ${short(text)}`);
    }
    const name = doc.schema?.match(/^yoneda\.cli\.(.+)\.v1$/)?.[1];
    assert.ok(name, `yoneda ${args.join(' ')} --json names no schema: ${short(text)}`);
    const file = join(this.root, 'schemas/v1', `${name}.schema.json`);
    assert.ok(existsSync(file), `no schemas/v1 file for ${doc.schema}`);
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    const shape = schema.$defs?.[schema.properties?.data?.$ref?.split('/').pop()];
    for (const field of shape?.required ?? []) assert.ok(field in doc.data, `${doc.schema} lacks ${field}: ${short(text)}`);
    this.schemas.set(name, (this.schemas.get(name) ?? 0) + 1);
    return doc.data;
  }
  /** Every schemas/v1 name, as `document` records them. */
  allSchemas() {
    return readdirSync(join(this.root, 'schemas/v1')).filter((f) => f.endsWith('.schema.json')).map((f) => f.replace('.schema.json', ''));
  }
  /** Runs one table row. A failure is the row's and the walk goes on. */
  async row(id, body) {
    assert.ok(this.table.includes(id), `the table has no row ${id}`);
    assert.ok(!this.results.has(id), `row ${id} ran twice`);
    const started = performance.now();
    try {
      const note = await body();
      this.results.set(id, { status: 'pass', ms: Math.round(performance.now() - started), note: typeof note === 'string' ? note : '' });
    } catch (error) {
      this.results.set(id, { status: 'fail', ms: Math.round(performance.now() - started), note: scrubbed(short(error.message.split('\n').filter(Boolean).slice(0, 12).join(' '), 500), this.secrets) });
    }
  }
  /** A row that cannot run, and why. */
  notRun(id, why) {
    assert.ok(this.table.includes(id), `the table has no row ${id}`);
    this.results.set(id, { status: 'not run', ms: 0, note: why });
  }
  /** Runs a row only when `ready` (what an earlier row made) exists. */
  async rowOf(id, ready, what, body) {
    if (ready) await this.row(id, body);
    else this.results.set(id, { status: 'fail', ms: 0, note: `${what} did not get made` });
  }
  /** Waits for `probe`, on the platform's 1 s access bound. */
  soon = (probe, what) => until(probe, { timeoutMs: 15_000, intervalMs: 500, what });
  /** Waits for something that takes minutes: a check in a container. */
  soonLong = (probe, what) => until(probe, { timeoutMs: 10 * 60_000, intervalMs: 5000, what });
  /** Removes the workspace with every stored credential in it. */
  dispose() {
    assert.ok(statSync(this.dir).isDirectory());
    rmSync(this.dir, { recursive: true, force: true });
  }
}
