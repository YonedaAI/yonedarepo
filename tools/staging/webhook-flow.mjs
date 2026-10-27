// Webhook live gate (B3) for the staging kit: a hook on a fresh repository posts to a
// receiver box on the bench Worker (tools/fanout-bench/worker.js, `/hooks/<box>`), which
// fails the first delivery on purpose. Passes when every land, branch and tag event
// arrives signed (verified by the box and here), in log order, the failed delivery is
// retried with the same id and shows in the delivery log, an unsafe target is refused,
// and a deleted hook sends nothing more. The receiver must be a host the platform may
// call: never this account's workers.dev (the platform refuses it as a target).
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { b64, sleep, until } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };

async function box(receiver, key, name, method = 'GET', body) {
  const response = await fetch(`${receiver}/hooks/${name}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-bench-key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `receiver ${method}: ${response.status}`);
  return response.json();
}

/** `receiver`: the bench Worker origin serving `/hooks/<box>`; `key`: its BENCH_KEY. */
export async function webhookFlow(platform, { receiver, key }, metrics) {
  if (!receiver) return { skip: 'No --receiver (a host the platform may call)' };
  if (!key) return { skip: 'BENCH_KEY not in staging-bench.env' };
  const name = `kit-hooks-${Date.now()}`;
  const repo = await platform.post('/repos', { name, policy: { required_checks: [], approvals: 0 }, files: [{ path: 'README.md', content_b64: b64('# Hooks\n') }], author });
  try {
    const refused = await platform.raw('POST', `/repos/${repo.id}/hooks`, { url: 'https://169.254.169.254/latest/meta-data' });
    assert.equal(refused.status, 400, 'a link-local target is refused');
    const boxName = `kit-${randomBytes(6).toString('hex')}`;
    const hook = await platform.post(`/repos/${repo.id}/hooks`, { url: `${receiver}/hooks/${boxName}`, events: ['land', 'branch', 'tag'] });
    assert.match(hook.secret, /^whsec_[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(await platform.get(`/repos/${repo.id}/hooks`)).includes(hook.secret), 'listings never show the secret');
    await box(receiver, key, boxName, 'PUT', { secret: hook.secret, fail_next: 1 });

    const landedAt = [];
    const commits = [];
    for (const n of [1, 2, 3]) {
      const made = await platform.post(`/repos/${repo.id}/commits`, { ref: 'main', changes: [{ path: `n${n}.txt`, content_b64: b64(`${n}\n`) }], message: `Hook ${n}`, author });
      await platform.post(`/repos/${repo.id}/land`, { ref: 'main', commit: made.commit });
      landedAt.push(Date.now());
      commits.push(made.commit);
    }
    await platform.post(`/repos/${repo.id}/branches`, { ref: 'kit-hooks', commit: commits[2], expected: null });
    await platform.post(`/repos/${repo.id}/tags`, { name: 'kit-v1', commit: commits[2] });

    // The first attempt fails by script; its retry waits out a 10 s backoff.
    const delivered = await until(
      async () => {
        const { deliveries } = await box(receiver, key, boxName);
        const ok = deliveries.filter((d) => d.status === 200);
        return ok.length >= 5 && deliveries;
      },
      { timeoutMs: 180_000, intervalMs: 3000, what: 'five delivered hook events' },
    );
    const ok = delivered.filter((d) => d.status === 200);
    for (const d of delivered) {
      assert.equal(d.verified, true, `receiver verified ${d.delivery}`);
      const expected = createHmac('sha256', hook.secret).update(d.body).digest('hex');
      assert.equal(d.signature, `sha256=${expected}`, `signature of ${d.delivery}`);
      assert.equal(JSON.parse(d.body).delivery_id, d.delivery);
    }
    const events = ok.map((d) => JSON.parse(d.body));
    assert.deepEqual(
      events.map((e) => e.event),
      ['land', 'land', 'land', 'branch', 'tag'],
      'events arrive in log order',
    );
    assert.deepEqual(events.slice(0, 3).map((e) => e.commit), commits);
    const versions = events.map((e) => e.version);
    assert.deepEqual([...versions].sort((a, b) => a - b), versions, 'versions ascend');
    assert.equal(delivered[0].status, 500);
    assert.equal(delivered[1].delivery, delivered[0].delivery, 'the failed delivery is retried with its id');
    assert.equal(delivered[1].body, delivered[0].body, 'with the same signed bytes');
    const log = await platform.get(`/repos/${repo.id}/hooks/${hook.id}/deliveries`);
    assert.ok(log.deliveries.some((d) => !d.ok && d.status === 500 && d.attempt === 1));
    assert.ok(log.deliveries.some((d) => d.ok && d.attempt === 2));

    await platform.call('DELETE', `/repos/${repo.id}/hooks/${hook.id}`);
    const made = await platform.post(`/repos/${repo.id}/commits`, { ref: 'main', changes: [{ path: 'after.txt', content_b64: b64('after\n') }], message: 'After delete', author });
    await platform.post(`/repos/${repo.id}/land`, { ref: 'main', commit: made.commit });
    await sleep(20_000);
    const after = (await box(receiver, key, boxName)).deliveries.length;
    assert.equal(after, delivered.length, 'a deleted hook sends nothing more');

    Object.assign(metrics, {
      delivered: ok.length,
      attempts: delivered.length,
      first_land_to_receipt_ms: delivered[0].at - landedAt[0],
      log_entries: log.deliveries.length,
    });
  } finally {
    await platform.call('DELETE', `/repos/${repo.id}?confirm=${encodeURIComponent(name)}`).catch((e) => console.error(`Deleting ${name} failed: ${e.message}`));
  }
}
