import { providerNames } from '../workspace/ProviderSettings';

export type ProviderFailureCode =
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
  | 'HARNESS_BUDGET';

const notices: Record<ProviderFailureCode, { title: string; action: string }> = {
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
      'Wait for the provider allowance to reset or choose another connection, then start a new run.',
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
    action: 'Restart with a larger approved request allowance or a smaller brief.',
  },
  MODEL_SPEND_LIMIT: {
    title: 'estimated model allowance was reached',
    action:
      'Review the approved pricing and remaining allowance. Restart with a larger allowance or a smaller task; the next request must fit its worst-case reservation.',
  },
  HARNESS_BUDGET: {
    title: 'execution budget was reached',
    action:
      'The agent stopped at its execution budget. No candidate was captured. Start a smaller run or choose another approved connection.',
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
  const explicit = providerFailureCode(execution.error_code);
  if (explicit) return explicit;
  const prefix =
    typeof execution.error === 'string'
      ? /^([A-Z_]{1,48}):(?:\s|$)/.exec(execution.error.slice(0, 64))?.[1]
      : undefined;
  return providerFailureCode(prefix);
}

export function providerFailureNotice(execution: Record<string, any>, code?: ProviderFailureCode) {
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
        title: `${provider} execution failed`,
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

/** Read only the final structured result; free text and intermediate tool output are not causes. */
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
    return row.is_error === true && row.terminal_reason === 'api_error'
      ? statusCode(row.api_error_status)
      : undefined;
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
