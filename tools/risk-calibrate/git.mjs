// Read-only Git over a bare clone: plain commands, and one long-lived `cat-file --batch`.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BUFFER = 512 * 1024 * 1024;

/** `git <args>` in `dir`. Hooks and config of a clone never run: nothing here executes its content. */
export async function git(dir, args, encoding = 'utf8') {
  const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: BUFFER, encoding });
  return stdout;
}

/** Blob reads, one at a time, in the order asked. */
export class Blobs {
  constructor(dir) {
    this.child = spawn('git', ['-C', dir, 'cat-file', '--batch'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.buffer = Buffer.alloc(0);
    this.waiting = null;
    this.child.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.waiting?.();
    });
  }

  async #bytes(enough) {
    while (!enough()) await new Promise((wake) => (this.waiting = wake));
    this.waiting = null;
  }

  /** The blob's bytes, or null if the clone doesn't hold it. */
  async read(id) {
    this.child.stdin.write(`${id}\n`);
    await this.#bytes(() => this.buffer.includes(10));
    const end = this.buffer.indexOf(10);
    const header = this.buffer.subarray(0, end).toString().split(' ');
    this.buffer = this.buffer.subarray(end + 1);
    if (header[1] === 'missing') return null;
    const size = Number(header[2]);
    await this.#bytes(() => this.buffer.length > size);
    const body = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size + 1);
    return Buffer.from(body);
  }

  close() {
    this.child.stdin.end();
  }
}

/** The platform's own code, by `cargo run --example compute_lines`'s built binary. */
export class Compute {
  constructor(binary) {
    this.child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.text = '';
    this.waiting = null;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.text += chunk;
      this.waiting?.();
    });
  }

  async call(request) {
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    while (!this.text.includes('\n')) await new Promise((wake) => (this.waiting = wake));
    const end = this.text.indexOf('\n');
    const answer = JSON.parse(this.text.slice(0, end));
    this.text = this.text.slice(end + 1);
    if (answer?.error) throw new Error(`compute ${request.op}: ${answer.error}`);
    return answer;
  }

  close() {
    this.child.stdin.end();
  }
}

/** Runs `work` over `items`, at most `limit` at a time. */
export async function pool(items, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: limit }, worker));
}
