// Contact support (`POST /api/v1/support`) through the real account authority and D1
// (workerd), with Resend's endpoint stubbed: a person's browser session only, the message
// and attachment limits, the daily limit, an untrusted message in a text-only email, the
// reply address taken from the account, and retryable failures. No real Resend calls.
import { expect, it, vi } from 'vitest';
import { RESEND_EMAILS } from '../../cloudflare/worker/platform-welcome-email';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const configured = {
  ...scoped,
  RESEND_API_KEY: { get: async () => 're_test_key' },
  EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.test>',
  SUPPORT_EMAIL: 'support@yonedalabs.test',
  WEB_ORIGIN: 'https://yonedarepo.test',
} as unknown as Env;

/** Resend's endpoint: records each request and answers with the next scripted status. */
function resend(answers: (number | Error)[] = []) {
  const got: { headers: Headers; json: any }[] = [];
  const passthrough = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== RESEND_EMAILS) return passthrough(input, init);
    const req = new Request(input, init);
    got.push({ headers: req.headers, json: await req.json() });
    const next = answers.shift() ?? 200;
    if (next instanceof Error) throw next;
    return Response.json(next === 200 ? { id: 'email-1' } : { name: 'application_error' }, { status: next });
  });
  return got;
}
/** `configured` with one account authority command answered by `answer`. */
function authority(op: string, answer: () => Promise<Response>) {
  const real = configured.WORKSPACES;
  const WORKSPACES = {
    idFromName: (name: string) => real.idFromName(name),
    get: (id: DurableObjectId) => ({
      fetch: (url: string, init: RequestInit) =>
        String(init.body).includes(`"op":"${op}"`) ? answer() : real.get(id).fetch(url, init),
    }),
  };
  return { ...configured, WORKSPACES } as unknown as Env;
}
const post = (cookie: string, body: unknown, target: Env = configured) =>
  api('/support', { cookie }, { body }, target);
const message = 'The push page shows an error.';
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = new TextEncoder().encode('%PDF-1.7\n');
const png = { name: 'shot.png', type: 'image/png', data: base64(PNG) };
/** `size` bytes of PNG signature and padding, as base64, without a stack-sized spread. */
function bigPng(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set(PNG);
  let binary = '';
  for (let i = 0; i < size; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { name: 'big.png', type: 'image/png', data: btoa(binary) };
}

it('sends one text-only email to support, replying to the address on the account', async () => {
  const cookie = await signup('ada');
  await api('/repos', { cookie }, { body: { name: 'shown', files: [file('README.md', '# shown\n')], author } });
  const got = resend();
  const sent = await post(cookie, {
    message,
    page: 'https://yonedarepo.test/ada/shown?tab=files#top',
    // Client-supplied addresses are not fields of this request and change nothing.
    reply_to: 'evil@example.net',
    email: 'evil@example.net',
    to: 'evil@example.net',
  });
  expect(sent).toMatchObject({ status: 200, body: { sent: true, email: 'ada@example.com' } });
  expect(got).toHaveLength(1);
  const { headers, json } = got[0];
  expect(headers.get('authorization')).toBe('Bearer re_test_key');
  expect(headers.get('idempotency-key')).toMatch(/^support\/[0-9a-f]{64}$/);
  expect(json).toMatchObject({
    from: 'YonedaRepo <hello@yonedarepo.test>',
    to: ['support@yonedalabs.test'],
    reply_to: 'ada@example.com',
    subject: 'Support: ada (The push page shows an error.)',
  });
  expect(json.html).toBeUndefined();
  expect(json.attachments).toBeUndefined();
  expect(json.text).toContain('Account: ada');
  expect(json.text).toContain('Handle: ada');
  expect(json.text).toContain('Email: ada@example.com (not confirmed)');
  expect(json.text).toContain('Repositories: 1');
  expect(json.text).toContain('Page: https://yonedarepo.test/ada/shown?tab=files');
  expect(json.text).toContain(`\n${message}`);
  expect(JSON.stringify(json)).not.toContain('evil@example.net');
});

it('names only this site in the page line, whatever the client sends', async () => {
  const cookie = await signup('ada');
  const got = resend();
  expect((await post(cookie, { message, page: 'https://evil.example/phish?x=1' })).status).toBe(200);
  expect(got[0].json.text).toContain('Page: https://yonedarepo.test/phish?x=1');
  expect(got[0].json.text).not.toContain('evil.example');
  for (const page of [undefined, 'not a url', 42, 'javascript:alert(1)']) {
    expect((await post(cookie, { message: `${message} ${page}`, page })).status).toBe(200);
    expect(got.at(-1)?.json.text).toContain('Page: unknown');
  }
});

it('refuses anyone but a signed-in person, before reading the request', async () => {
  const cookie = await signup('ada');
  const got = resend();
  const pat = (await api('/tokens', { cookie }, { body: { name: 'cli', scopes: ['repo:read'] } })).body.token;
  const created = await api('/repos', { cookie }, { body: { name: 'shown', files: [file('README.md', '# shown\n')], author } });
  const repoToken = (
    await api(`/repos/${created.body.id}/tokens`, { cookie }, { body: { name: 'ci', scopes: ['read'] } })
  ).body.token;
  expect(repoToken).toMatch(/^yrp_/);
  const body = { message };
  expect((await api('/support', {}, { body }, configured)).status).toBe(401);
  expect((await api('/support', { token: pat }, { body }, configured)).status).toBe(403);
  expect((await api('/support', { token: repoToken }, { body }, configured)).status).toBe(403);
  expect((await api('/support', { token: 'local-test-owner' }, { body }, configured)).status).toBe(403);
  expect((await api('/support', { token: 'ypat_nope' }, { body }, configured)).status).toBe(401);
  expect((await api('/support', { cookie }, {}, configured)).status).toBe(404); // a GET
  expect(got).toHaveLength(0);
});

it('refuses an empty message and one over the limit', async () => {
  const cookie = await signup('ada');
  const got = resend();
  for (const body of [{}, { message: 42 }, { message: '' }, { message: ' \n\t ' }, { message: 'x'.repeat(5001) }]) {
    const refused = await post(cookie, body);
    expect(refused.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_INPUT');
  }
  expect(got).toHaveLength(0);
  expect((await post(cookie, { message: 'x'.repeat(5000) })).status).toBe(200);
  expect(got).toHaveLength(1);
});

it('keeps the subject to one line of 60 characters, stripping injected headers', async () => {
  const cookie = await signup('ada');
  const got = resend();
  const injected = 'hello\r\nBcc: evil@example.net\u2028\u0085\tnext\n\n' + 'y'.repeat(100);
  expect((await post(cookie, { message: injected })).status).toBe(200);
  const { subject, text } = got[0].json;
  expect(subject).not.toMatch(/[\r\n\u2028\u2029\u0085\t]/);
  const quoted = /^Support: ada \((.*)\)$/.exec(subject)?.[1];
  expect(quoted).toBe('hello Bcc: evil@example.net next yyyyyyyyyyyyyyyyyyyyyyyyyyy');
  expect(quoted).toHaveLength(60);
  // The body keeps the person's lines, as plain text.
  expect(text).toContain('hello\nBcc: evil@example.net');
  // An emoji at the cut stays whole.
  await post(cookie, { message: `${'z'.repeat(59)}😀 and on` });
  expect(got[1].json.subject).toBe(`Support: ada (${'z'.repeat(59)}😀)`);
});

it('allows five requests a day per account, then answers 429 and sends nothing', async () => {
  const cookie = await signup('ada');
  const other = await signup('grace');
  const got = resend();
  for (let n = 0; n < 5; n++) expect((await post(cookie, { message: `${message} ${n}` })).status).toBe(200);
  const refused = await post(cookie, { message });
  expect(refused.status).toBe(429);
  expect(refused.body.error.code).toBe('RATE_LIMITED');
  expect(refused.body.error.message).toMatch(/tomorrow/);
  expect(got).toHaveLength(5);
  expect((await post(other, { message })).status).toBe(200);
});

it('fails closed when the account authority cannot count the request', async () => {
  const cookie = await signup('ada');
  const got = resend();
  const broken = authority('support_admit', async () => {
    throw new Error('authority unavailable');
  });
  expect((await post(cookie, { message }, broken)).status).toBe(500);
  expect(got).toHaveLength(0);
});

it('sends one image, PDF or text file as a base64 attachment', async () => {
  const cookie = await signup('ada');
  const got = resend();
  expect((await post(cookie, { message, attachment: png })).status).toBe(200);
  expect(got[0].json.attachments).toEqual([{ filename: 'shot.png', content: png.data, content_type: 'image/png' }]);
  expect(got[0].json.text).toContain('Attachment: shot.png (image/png, 11 bytes)');
  const pdf = { name: 'report.pdf', type: 'application/pdf', data: base64(PDF) };
  expect((await post(cookie, { message: 'pdf', attachment: pdf })).status).toBe(200);
  expect(got[1].json.attachments[0]).toMatchObject({ filename: 'report.pdf', content_type: 'application/pdf' });
  // Text, under a name Resend would refuse, a path and a header-breaking name.
  const text = { name: '../../run\r\nx.js', type: '', data: btoa('line one\nline two\n') };
  expect((await post(cookie, { message: 'log', attachment: text })).status).toBe(200);
  expect(got[2].json.attachments[0]).toMatchObject({ filename: 'run_x.js.txt', content_type: 'text/plain' });
  // The largest one allowed, and the full body it takes, go through.
  const large = bigPng(5 * 1024 * 1024);
  expect((await post(cookie, { message: 'x'.repeat(5000), attachment: large })).status).toBe(200);
  expect(got[3].json.attachments[0].content).toBe(large.data);
});

it('refuses an attachment by its real type and size', async () => {
  const cookie = await signup('ada');
  const got = resend();
  const refusals = [
    // Declared types outside the list.
    { name: 'a.svg', type: 'image/svg+xml', data: btoa('<svg onload="x"/>') },
    { name: 'a.html', type: 'text/html', data: btoa('<script>x</script>') },
    { name: 'a.zip', type: 'application/zip', data: btoa('PK\x03\x04') },
    // Bytes that are not what the name and type claim.
    { name: 'a.png', type: 'image/png', data: btoa('not a picture') },
    { name: 'a.pdf', type: 'image/png', data: base64(PDF) },
    { name: 'a.exe', type: 'application/pdf', data: btoa('MZ\x00\x01') },
    { name: 'a.txt', type: 'text/plain', data: btoa('binary\x00bytes') },
    { name: 'a.txt', type: 'text/plain', data: base64(new Uint8Array([0xff, 0xfe, 0x41])) },
    // Malformed.
    { name: 'a.png', type: 'image/png', data: '%%% not base64' },
    { name: 'a.png', type: 'image/png', data: '' },
    { name: 'a.png', type: 'image/png' },
    'shot.png',
  ];
  for (const attachment of refusals) {
    const refused = await post(cookie, { message, attachment });
    expect(refused.status, JSON.stringify(attachment).slice(0, 60)).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_INPUT');
  }
  const over = await post(cookie, { message, attachment: bigPng(5 * 1024 * 1024 + 1) });
  expect(over.status).toBe(400);
  expect(over.body.error.message).toMatch(/5 MB/);
  // A body too large for any allowed attachment is refused while it is read.
  expect((await post(cookie, { message, attachment: bigPng(6 * 1024 * 1024) })).status).toBe(400);
  expect(got).toHaveLength(0);
});

it('asks an account with no email to add one', async () => {
  const cookie = await signup('ada');
  const got = resend();
  const spoof = authority('email_status', async () => Response.json({ email: null, verified: false }));
  const refused = await post(cookie, { message }, spoof);
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe('NO_EMAIL');
  expect(refused.body.error.message).toMatch(/add .*email/i);
  expect(got).toHaveLength(0);
});

it('answers 503 while email is not set up, and counts nothing', async () => {
  const cookie = await signup('ada');
  const got = resend();
  const unset = ['RESEND_API_KEY', 'SUPPORT_EMAIL', 'EMAIL_FROM', 'WEB_ORIGIN'];
  for (const name of unset) {
    const refused = await post(cookie, { message }, { ...configured, [name]: undefined } as Env);
    expect(refused.status, name).toBe(503);
    expect(refused.body.error.code).toBe('SUPPORT_UNAVAILABLE');
  }
  const empty = { ...configured, RESEND_API_KEY: { get: async () => ' ' } } as unknown as Env;
  expect((await post(cookie, { message }, empty)).status).toBe(503);
  expect(got).toHaveLength(0);
  // Nothing above used up the day's requests.
  for (let n = 0; n < 5; n++) expect((await post(cookie, { message: `${n}` })).status).toBe(200);
});

it('answers a retryable error when Resend fails, gives the slot back, and repeats the key', async () => {
  const cookie = await signup('ada');
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const got = resend([500, 429, 422, new Error('connection lost')]);
  for (let n = 0; n < 4; n++) {
    const failed = await post(cookie, { message });
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('SUPPORT_SEND_FAILED');
    expect(failed.body.error.message).toMatch(/try again/i);
  }
  // None of those four counted: five more still go through (the first repeats the request).
  for (let n = 0; n < 5; n++) expect((await post(cookie, { message: n ? `${n}` : message })).status).toBe(200);
  expect((await post(cookie, { message: 'sixth' })).status).toBe(429);
  const keys = got.slice(0, 5).map((g) => g.headers.get('idempotency-key'));
  expect(new Set(keys).size).toBe(1);
  // Failures are logged without the address.
  const lines = logged.mock.calls.flat().join('\n');
  expect(lines).toContain('email.support.failed');
  expect(lines).not.toContain('ada@example.com');
  expect(lines).toContain('a…@example.com');
});
