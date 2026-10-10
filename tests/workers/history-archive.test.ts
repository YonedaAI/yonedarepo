import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock('../../cloudflare/worker/storage', () => ({ ledger: ledgerMock }));

import { archiveDueHistory, historyDetail, mergeArchivedHistoryDetail } from '../../cloudflare/worker/history-archive';
import type { Env, Json } from '../../cloudflare/worker/types';

const sha = async (content: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

function archiveEnv(initial: string | null = null) {
  let stored = initial;
  const puts: Array<{ key: string; body: string; options: Json }> = [];
  const env = {
    OBJECTS: {
      put: async (key: string, body: string, options: Json) => {
        puts.push({ key, body, options });
        if (options.onlyIf?.etagDoesNotMatch === '*' && stored !== null) return null;
        stored = body;
        return {};
      },
      get: async () => (stored === null ? null : { text: async () => stored as string }),
    },
  } as unknown as Env;
  return { env, puts, read: () => stored };
}

describe('history archive delivery', () => {
  beforeEach(() => ledgerMock.mockReset());

  it('uploads the exact Rust bundle bytes immutably and commits only after digest readback', async () => {
    const body = '{"100":"hundred","2":"two","label":"exact bytes"}';
    const digest = await sha(body);
    const receipt = { id: 'receipt' };
    const { env, puts, read } = archiveEnv();
    ledgerMock
      .mockResolvedValueOnce({ run_ids: ['run-one'] })
      .mockResolvedValueOnce({ job: { id: 'archive:run-one', digest, object_key: 'history/repo/run-one.json' }, bundle_json: body })
      .mockResolvedValueOnce(receipt);

    await expect(archiveDueHistory(env, 'repo', 100)).resolves.toEqual([receipt]);
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toBe(body);
    expect(puts[0].options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
    expect(read()).toBe(body);
    expect(ledgerMock.mock.calls[2][2]).toMatchObject({ digest, verified_digest: digest });
  });

  it('replays an existing immutable object without replacing it and refuses corrupted bytes', async () => {
    const body = '{"2":"two","100":"hundred"}';
    const digest = await sha(body);
    const receipt = { id: 'receipt' };
    const { env, puts } = archiveEnv(body);
    ledgerMock
      .mockResolvedValueOnce({ run_ids: ['run-one'] })
      .mockResolvedValueOnce({ job: { id: 'archive:run-one', digest, object_key: 'history/repo/run-one.json' }, bundle_json: body })
      .mockResolvedValueOnce(receipt);
    await expect(archiveDueHistory(env, 'repo', 100)).resolves.toEqual([receipt]);
    expect(puts).toHaveLength(1);

    const corrupt = archiveEnv('{"wrong":true}');
    ledgerMock.mockClear();
    ledgerMock
      .mockResolvedValueOnce({ run_ids: ['run-one'] })
      .mockResolvedValueOnce({ job: { id: 'archive:run-one', digest, object_key: 'history/repo/run-one.json' }, bundle_json: body });
    await expect(archiveDueHistory(corrupt.env, 'repo', 100)).rejects.toThrow('Stored history digest mismatch');
    expect(ledgerMock).toHaveBeenCalledTimes(2);
  });

  it('hydrates run detail once from R2 and overlays current authoritative ledger records', async () => {
    const archived: Json = {
      run: { id: 'run-one', status: 'ready' }, runs: [{ id: 'run-one', status: 'ready' }],
      executions: [], candidates: [{ id: 'old-candidate' }], evaluations: [{ id: 'old-eval' }],
      decisions: [], team_tasks: [], team_handoffs: [], artifacts: [],
      nodes: [{ id: 'archived-node' }], edges: [{ source: 'archived-node', target: 'run-one' }],
      execution_logs: [{ event_id: 'compacted-log', data: { stage: 'execution.finished' } }],
    };
    const hot: Json = {
      repository: { head_commit: 'current-head' }, run: { id: 'run-one', status: 'accepted' },
      runs: [{ id: 'run-one', status: 'accepted' }], executions: [], candidates: [{ id: 'current-candidate' }],
      evaluations: [{ id: 'current-evaluation' }], decisions: [{ id: 'current-decision' }],
      team_tasks: [], team_handoffs: [], artifacts: [], archive: { digest: 'verified' },
      capabilities: { history: 1 }, seq: 42,
    };
    const body = JSON.stringify(archived);
    const digest = await sha(body);
    const { env } = archiveEnv(body);
    ledgerMock
      .mockResolvedValueOnce(hot)
      .mockResolvedValueOnce({ object_key: 'history/repo/run-one.json', digest });

    const detail = await historyDetail(env, 'repo', 'run-one');
    expect(detail.run.status).toBe('accepted');
    expect(detail.candidates).toEqual(hot.candidates);
    expect(detail.evaluations).toEqual(hot.evaluations);
    expect(detail.decisions).toEqual(hot.decisions);
    expect(detail.nodes).toEqual(archived.nodes);
    expect(detail.execution_logs).toEqual(archived.execution_logs);
    expect(ledgerMock.mock.calls.map(([, , input]) => input.op)).toEqual(['run_detail', 'archive_status']);
  });
});

it('overlays current ledger state on preserved archive graph and logs after a run advances', () => {
  const archived: Json = {
    repository: { head_commit: 'old' },
    run: { id: 'run-one', status: 'ready' },
    runs: [{ id: 'run-one', status: 'ready' }],
    executions: [{ id: 'exec-one', run_id: 'run-one', status: 'completed' }],
    candidates: [{ id: 'candidate-old', run_id: 'run-one' }],
    evaluations: [{ id: 'eval-old', candidate: 'candidate-old' }],
    decisions: [], team_tasks: [], team_handoffs: [], artifacts: [],
    nodes: [{ id: 'archived-node' }], edges: [{ source: 'archived-node', target: 'run-one' }],
    execution_logs: [{ event_id: 'archived-log' }], archive: null,
  };
  const hot: Json = {
    repository: { head_commit: 'new' },
    run: { id: 'run-one', status: 'accepted' },
    runs: [{ id: 'run-one', status: 'accepted' }],
    executions: [{ id: 'exec-one', run_id: 'run-one', status: 'completed' }],
    candidates: [{ id: 'candidate-new', run_id: 'run-one' }],
    evaluations: [{ id: 'eval-new', candidate: 'candidate-new' }],
    decisions: [{ id: 'decision-new', run_id: 'run-one' }],
    team_tasks: [], team_handoffs: [], artifacts: [],
    archive: { digest: 'verified' }, capabilities: { history: 1 }, seq: 99,
  };

  const detail = mergeArchivedHistoryDetail(archived, hot, 'run-one');
  expect(detail.run.status).toBe('accepted');
  expect(detail.archived_run.status).toBe('ready');
  expect(detail.repository.head_commit).toBe('new');
  expect(detail.evaluations).toEqual(hot.evaluations);
  expect(detail.decisions).toEqual(hot.decisions);
  expect(detail.nodes).toEqual(archived.nodes);
  expect(detail.edges).toEqual(archived.edges);
  expect(detail.execution_logs).toEqual(archived.execution_logs);
});
