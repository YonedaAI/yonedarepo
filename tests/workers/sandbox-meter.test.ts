// Sandbox spend metering: each model response's own usage report is read from a copy of the
// stream the CLI receives unchanged, recorded once on the run through the real ledger, and a
// new request is refused (402) only once the run's approved allowance is actually spent.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import {
  forwardModel,
  type MeterFormat,
  type MeteredUsage,
  meterFormat,
  meterResponse,
  requestUsageReport,
} from '../../cloudflare/worker/sandbox-meter';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { readyReviewer } from './reviewer-fixture';
import * as samples from './sandbox-meter-samples';

const bindings = env as unknown as Env;
afterEach(reset);

/** The body in small uneven chunks, so events and lines split across reads. */
function chunked(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
      size = size === 7 ? 13 : 7;
    },
  });
}

const upstream = (text: string, type = 'text/event-stream') =>
  new Response(chunked(text), { headers: { 'content-type': type } });

async function metered(format: MeterFormat, text: string, type?: string) {
  const reports: MeteredUsage[] = [];
  const response = meterResponse(upstream(text, type), format, (usage) => reports.push(usage));
  return { body: await response.text(), reports };
}

it('reads each API format usage from the stream and passes every byte through', async () => {
  const cases: [MeterFormat, string, MeteredUsage][] = [
    ['anthropic', samples.anthropicStream, samples.anthropicUsage],
    ['responses', samples.responsesStream, samples.responsesUsage],
    ['chat', samples.chatStream, samples.chatUsage],
    ['gemini', samples.geminiStream, samples.geminiUsage],
  ];
  for (const [format, text, usage] of cases) {
    const { body, reports } = await metered(format, text);
    expect(body).toBe(text);
    expect(reports).toEqual([usage]);
  }
  const json = await metered('anthropic', samples.anthropicJson, 'application/json');
  expect(json.body).toBe(samples.anthropicJson);
  expect(json.reports).toEqual([
    { input_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 12 },
  ]);
  // Errors and usage-free bodies record nothing.
  expect((await metered('anthropic', 'data: {"type":"ping"}\n\n')).reports).toEqual([]);
  const failed = meterResponse(new Response('{"error":{}}', { status: 429 }), 'anthropic', () => {
    throw new Error('not metered');
  });
  expect(failed.status).toBe(429);
});

it('meters the model APIs and leaves token counting free', () => {
  expect(meterFormat('/api/anthropic/v1/messages')).toBe('anthropic');
  expect(meterFormat('/api/anthropic/v1/messages/count_tokens')).toBeNull();
  expect(meterFormat('/v1/responses')).toBe('responses');
  expect(meterFormat('/v1/chat/completions')).toBe('chat');
  expect(meterFormat('/v1beta/models/gemini-3-flash:streamGenerateContent')).toBe('gemini');
});

it('asks a Chat Completions stream for its usage and changes nothing else', () => {
  const asked = JSON.parse(requestUsageReport('{"model":"m","stream":true,"messages":[]}'));
  expect(asked.stream_options).toEqual({ include_usage: true });
  const plain = '{"model":"m","messages":[]}';
  expect(requestUsageReport(plain)).toBe(plain);
});

it('records real spend per response and refuses only once the approved allowance is spent', async () => {
  const fixture = await readyReviewer('sandbox_meter');
  const repo = fixture.repo;
  // GLM 5.3 Flash at $0.15/M input, $0.50/M output; this run may spend $0.002.
  const budget = {
    provider: 'zai',
    model: 'glm-5.3-flash',
    max_requests: null,
    max_output_tokens: 4096,
    max_execution_ms: 600000,
    spend_limit_microusd: 2000,
    pricing: {
      input_microusd_per_million: 150000,
      output_microusd_per_million: 500000,
      source: 'owner-approved conservative rates',
    },
  };
  await ledger(bindings, repo, {
    op: 'start_run',
    id: 'meter-run',
    intent: 'Add add(a,b)',
    workspace_transport: 'sandbox-cli-v1',
    _source_transport_approved: true,
    _source_base: { repository: `platform/${repo}`, commit: fixture.head, tree: fixture.tree },
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'meter' }],
    model_budgets: [budget],
  });
  const job_id = 'job:meter-run:agent-1';
  await ledger(bindings, repo, { op: 'claim', job_id });
  const attempt = { project: repo, job_id, epoch: 1 };

  let sent = 0;
  const pending: Promise<unknown>[] = [];
  const request = (path: string) =>
    forwardModel(
      bindings,
      (work) => pending.push(work),
      new Request(`https://api.z.ai/api/anthropic${path}`, { method: 'POST', body: '{}' }),
      new Headers(),
      attempt,
      async () => {
        sent++;
        return upstream(samples.anthropicStream);
      },
    );
  const spend = async () => {
    await Promise.all(pending.splice(0));
    const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
    const run = snapshot.runs.find((r: { id: string }) => r.id === 'meter-run');
    return run.model_budgets[0].charged_microusd;
  };

  // 6500 input-side tokens and 420 output tokens: 1185 microdollars per response.
  expect(await (await request('/v1/messages')).text()).toBe(samples.anthropicStream);
  expect(await spend()).toBe(1185);
  expect(await (await request('/v1/messages')).text()).toBe(samples.anthropicStream);
  expect(await spend()).toBe(2370);
  expect(sent).toBe(2);

  // Spent: the next model request never leaves, and the CLI sees why.
  const refused = await request('/v1/messages');
  expect(refused.status).toBe(402);
  const error = (await refused.json()) as { error: { type: string; message: string } };
  expect(error.error.type).toBe('billing_error');
  expect(error.error.message).toContain('$0.0024 metered of $0.0020');
  expect(sent).toBe(2);
  // Token counting is free and still answers.
  await (await request('/v1/messages/count_tokens')).text();
  expect(sent).toBe(3);

  // A cancelled run stops further requests outright.
  await ledger(bindings, repo, { op: 'cancel_run', run_id: 'meter-run' });
  expect((await request('/v1/messages')).status).toBe(409);
});

it('records what a stream reported when the CLI hangs up mid-response', async () => {
  const reports: MeteredUsage[] = [];
  const response = meterResponse(upstream(samples.anthropicStream), 'anthropic', (usage) =>
    reports.push(usage),
  );
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let read = '';
  const decoder = new TextDecoder();
  while (!read.includes('event: ping')) read += decoder.decode((await reader.read()).value);
  await reader.cancel();
  // message_start was billed: its input-side tokens are recorded.
  expect(reports).toEqual([{ ...samples.anthropicUsage, output_tokens: 1 }]);
});
