import { providerNames } from '../workspace/providerModels';
import { platformFailureNotice } from './workflowFailure';

export type ProviderFailureCode =
  | 'EXECUTION_TIMEOUT'
  | 'PROVIDER_CONFIGURATION'
  | 'PROVIDER_BALANCE'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_FORBIDDEN'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_MODEL'
  | 'PROVIDER_REQUEST'
  | 'PROVIDER_REQUEST_LIMIT'
  | 'MODEL_REQUEST_LIMIT'
  | 'MODEL_SPEND_LIMIT'
  | 'CAMPAIGN_MODEL_REQUEST_LIMIT'
  | 'CAMPAIGN_EXHAUSTED'
  | 'HARNESS_BUDGET';

const notices: Record<ProviderFailureCode, { title: string; action: string }> = {
  EXECUTION_TIMEOUT: {
    title: 'stopped before finishing',
    action: 'Start the run again. No settings need to change.',
  },
  PROVIDER_CONFIGURATION: {
    title: 'key and billing settings do not match',
    action:
      'Edit the saved connection. A MiMo tp- or ttp- key needs Token Plan and its assigned region. Then use Restart run.',
  },
  PROVIDER_BALANCE: {
    title: 'account balance is insufficient',
    action:
      'Add credits to your provider account or choose a funded connection, then start a new run.',
  },
  PROVIDER_AUTH: {
    title: 'authentication failed',
    action: 'Update the API key in provider connections, then start a new run.',
  },
  PROVIDER_FORBIDDEN: {
    title: 'denied this request',
    action:
      'Check that this provider account and API key can use the configured model, then start a new run.',
  },
  PROVIDER_RATE_LIMIT: {
    title: 'rate limit was reached',
    action:
      'Check provider rate/concurrency limits and model access, or choose another connection before restarting.',
  },
  PROVIDER_UNAVAILABLE: {
    title: 'service is temporarily unavailable',
    action: 'Try a new run later or choose another provider connection.',
  },
  PROVIDER_MODEL: {
    title: 'could not find the configured model',
    action: 'Check the model and provider connection settings, then start a new run.',
  },
  PROVIDER_REQUEST: {
    title: 'rejected the request',
    action: 'Check that the configured model and connection are compatible, then start a new run.',
  },
  PROVIDER_REQUEST_LIMIT: {
    title: 'request size limit was reached',
    action: 'Reduce the task or selected context, then start a new run.',
  },
  MODEL_REQUEST_LIMIT: {
    title: 'model request allowance was reached',
    action: 'Use Restart run to raise the approved request allowance or reduce the brief.',
  },
  MODEL_SPEND_LIMIT: {
    title: 'approved spend allowance is used up',
    action:
      'Requests already shrink their response to fit what remains; even the smallest response no longer fits. Use Restart run with a larger allowance to continue.',
  },
  CAMPAIGN_MODEL_REQUEST_LIMIT: {
    title: 'used this model’s shared campaign request allowance',
    action:
      'This model’s approved request allowance is used up. Recovery may assign remaining work to another already-approved model with allowance available. Campaign caps do not increase automatically.',
  },
  CAMPAIGN_EXHAUSTED: {
    title: 'cannot cover the next request with the approved campaign allowance',
    action:
      'The approved shared campaign allowance cannot cover the next request. Further work needs an owner decision on the budget; restarting does not reset or automatically increase the caps.',
  },
  HARNESS_BUDGET: {
    title: 'execution budget was reached',
    action:
      'The agent stopped at its execution budget. No candidate was captured. Use Restart run with a smaller task or another approved connection.',
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function providerFailureCode(value: unknown): ProviderFailureCode | undefined {
  return typeof value === 'string' && Object.hasOwn(notices, value)
    ? (value as ProviderFailureCode)
    : undefined;
}

export function executionFailureCode(execution: Record<string, any>) {
  if (execution.error === 'Execution deadline exceeded') return 'EXECUTION_TIMEOUT';
  const explicit = providerFailureCode(execution.error_code);
  if (explicit) return explicit;
  const prefix =
    typeof execution.error === 'string'
      ? /^([A-Z_]{1,48}):(?:\s|$)/.exec(execution.error.slice(0, 64))?.[1]
      : undefined;
  return providerFailureCode(prefix);
}

/** Timeouts are the platform stopping the agent, not a provider error or an owner setting. */
function timeoutNotice(execution: Record<string, any>) {
  const error = typeof execution.error === 'string' ? execution.error : '';
  const title = error.includes('No agent progress')
    ? 'Agent stopped after several minutes without progress'
    : error.includes('safety ceiling')
      ? 'Agent reached the 30-minute safety ceiling while still working'
      : 'Agent was stopped by the old fixed time limit, possibly while still working';
  return {
    title,
    action: execution.team_task
      ? 'Use Retry task. It continues from the files this attempt already wrote, and dependent tasks start when it succeeds. No settings need to change.'
      : notices.EXECUTION_TIMEOUT.action,
  };
}

export function providerFailureNotice(execution: Record<string, any>, code?: ProviderFailureCode) {
  const platform = platformFailureNotice(execution);
  if (platform) return platform;
  if (code === 'EXECUTION_TIMEOUT') return timeoutNotice(execution);
  const provider = providerNames[execution.provider ?? execution.harness] ?? 'Agent provider';
  return code
    ? {
        title: `${provider} ${notices[code].title}`,
        action:
          notices[code].action +
          (code === 'HARNESS_BUDGET' && !execution.budget && execution.harness === 'claude'
            ? ' The legacy Claude-compatible harness used a $1 execution cap.'
            : ''),
      }
    : {
        title: 'Run failed',
        action: 'This agent stopped before completing its approach.',
      };
}

function statusCode(status: unknown): ProviderFailureCode | undefined {
  if (status === 400 || status === 422) return 'PROVIDER_REQUEST';
  if (status === 402) return 'PROVIDER_BALANCE';
  if (status === 401) return 'PROVIDER_AUTH';
  if (status === 403) return 'PROVIDER_FORBIDDEN';
  if (status === 404) return 'PROVIDER_MODEL';
  if (status === 413) return 'PROVIDER_REQUEST_LIMIT';
  if (status === 429) return 'PROVIDER_RATE_LIMIT';
  if (typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599)
    return 'PROVIDER_UNAVAILABLE';
  return undefined;
}

function terminalBudgetCode(result: unknown): ProviderFailureCode | undefined {
  let body: unknown = result;
  if (typeof result === 'string') {
    const prefix = 'API Error: 409 ';
    const text = result.startsWith(prefix) ? result.slice(prefix.length) : result;
    if (
      text === 'This is a Token Plan key. Select Token Plan and its region.' ||
      text === 'Token Plan requires its dedicated tp- or ttp- key'
    )
      return 'PROVIDER_CONFIGURATION';
    if (text === 'This provider/model group exhausted its approved request budget')
      return 'MODEL_REQUEST_LIMIT';
    if (text === 'This model exhausted its original shared campaign request allowance')
      return 'CAMPAIGN_MODEL_REQUEST_LIMIT';
    if (text === 'Campaign, bucket, chain or model allowance exhausted')
      return 'CAMPAIGN_EXHAUSTED';
    if (
      text.startsWith(
        'This provider/model group has insufficient approved spend remaining for the conservative request ceiling',
      )
    )
      return 'MODEL_SPEND_LIMIT';
    try {
      body = JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (!record(body)) return undefined;
  const code = record(body.error) ? body.error.code : body.code;
  return code === 'MODEL_REQUEST_LIMIT' ||
    code === 'MODEL_SPEND_LIMIT' ||
    code === 'CAMPAIGN_MODEL_REQUEST_LIMIT' ||
    code === 'CAMPAIGN_EXHAUSTED' ||
    code === 'PROVIDER_CONFIGURATION'
    ? code
    : undefined;
}

/** Only final structured outcomes and exact broker budget denials are recognized. */
export function transcriptFailureCode(content: unknown): ProviderFailureCode | undefined {
  if (typeof content !== 'string' || content.length > 2_000_000) return undefined;
  let transcript: unknown;
  try {
    transcript = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!record(transcript) || typeof transcript.stdout !== 'string') return undefined;
  const tail = transcript.stdout.slice(-256_000);
  let end = tail.length;
  for (let inspected = 0; inspected < 4096 && end > 0; inspected++) {
    const start = tail.lastIndexOf('\n', end - 1) + 1;
    const line = tail.slice(start, end).trim();
    end = Math.max(0, start - 1);
    if (!line || line.length > 128_000) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record(row) || row.type !== 'result') continue;
    if (row.is_error === true && row.terminal_reason === 'budget_exhausted')
      return 'HARNESS_BUDGET';
    if (row.is_error !== true || row.terminal_reason !== 'api_error') return undefined;
    return row.api_error_status === 409
      ? terminalBudgetCode(row.result)
      : statusCode(row.api_error_status);
  }
  return undefined;
}

/** Bound the authenticated response and retain only an allowlisted diagnosis in component state. */
export async function inspectExecutionFailure(repo: string, digest: string, signal: AbortSignal) {
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error('unavailable');
  const response = await fetch(
    `/api/repos/${encodeURIComponent(repo)}/evidence?digest=${encodeURIComponent(digest)}`,
    { signal, credentials: 'same-origin' },
  );
  if (!response.ok || !response.body) throw new Error('unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error('too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const envelope: unknown = JSON.parse(text);
    return record(envelope) ? transcriptFailureCode(envelope.content) : undefined;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
