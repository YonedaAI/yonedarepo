// The stock coding CLI a sandbox runs, unmodified and headless, pinned in
// cloudflare/sandbox/Dockerfile: Claude Code, Codex CLI, opencode or MiMo Code (an opencode
// fork). Only the command lines (start, and resume of a session) and the environment are
// CLI-specific; the sandbox, activity log (sandbox-events-*.ts), push, landing and recording
// are shared. Every CLI gets the run's connection as its one model provider, pointed at
// `model_base` with a placeholder key: SandboxOutbound adds the real credential per request.
import { providerDefinition, type SandboxCli, sandboxCliFits } from '../../shared/providers';
import type { SandboxAttempt } from './sandbox-attempt';

export type AgentCli = {
  command: string[];
  env: Record<string, string>;
  /** The same CLI session continued with `prompt` (a team member's one conflict resume). */
  resume(sessionId: string, prompt: string): string[];
};

const PLACEHOLDER_KEY = 'provided-by-worker';

const refuse = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'SANDBOX_HARNESS' });
};

/** The attempt's CLI; attempts begun before the choice existed ran Claude Code. */
function cliOf(attempt: SandboxAttempt): SandboxCli {
  const cli = attempt.cli ?? 'claude';
  return sandboxCliFits(attempt.provider, cli)
    ? cli
    : refuse(`${cli} cannot run ${attempt.provider} models`);
}

type ModelApi = { npm: string; baseURL: string; endpoints: string[] };

/** Each provider API: its AI SDK package (bundled in opencode and MiMo Code) and paths. */
const PROTOCOL_API = {
  anthropic_messages: {
    npm: '@ai-sdk/anthropic',
    version: '/v1',
    endpoints: () => ['/messages', '/messages/count_tokens'],
  },
  openai_responses: { npm: '@ai-sdk/openai', version: '/v1', endpoints: () => ['/responses'] },
  gemini_generate_content: {
    npm: '@ai-sdk/google',
    version: '/v1beta',
    // The model is in the path: the sandbox reaches only the run's own model.
    endpoints: (model: string) => [
      `/models/${model}:streamGenerateContent`,
      `/models/${model}:generateContent`,
    ],
  },
} as const;

/** MiMo Code 0.1.16 calls every model whose id matches this through Chat Completions. */
const MIMO_CODE_CHAT = /(^|[/_-])mimo(?:-|$)/i;

/** The model API the attempt's CLI calls: its base URL and the endpoints under it. */
function modelApi(attempt: SandboxAttempt): ModelApi {
  if (cliOf(attempt) === 'mimo' && MIMO_CODE_CHAT.test(attempt.model)) {
    if (attempt.provider !== 'mimo') refuse(`MiMo Code cannot run ${attempt.model} here`);
    // MiMo's OpenAI-compatible API sits beside its Anthropic one, on every plan and region.
    return {
      npm: '@ai-sdk/openai-compatible',
      baseURL: `${attempt.model_base.replace(/\/anthropic$/, '')}/v1`,
      endpoints: ['/chat/completions'],
    };
  }
  const api = PROTOCOL_API[providerDefinition(attempt.provider).protocol];
  return {
    npm: api.npm,
    baseURL: `${attempt.model_base}${api.version}`,
    endpoints: api.endpoints(attempt.model),
  };
}

/** The URL paths, on the model base's host, the sandbox may POST model requests to. */
export function modelPaths(attempt: SandboxAttempt): string[] {
  const api = modelApi(attempt);
  const base = new URL(api.baseURL).pathname.replace(/\/$/, '');
  return api.endpoints.map((endpoint) => `${base}${endpoint}`);
}

export function agentCli(attempt: SandboxAttempt): AgentCli {
  const cli = cliOf(attempt);
  switch (cli) {
    case 'claude':
      return {
        command: claudeCommand(attempt, [], attempt.prompt),
        env: claudeEnv(attempt),
        resume: (sessionId, prompt) => claudeCommand(attempt, ['--resume', sessionId], prompt),
      };
    case 'codex':
      return {
        command: ['codex', 'exec', ...codexOptions(attempt), '--', attempt.prompt],
        env: { YONEDA_MODEL_KEY: PLACEHOLDER_KEY },
        resume: (sessionId, prompt) => [
          'codex',
          'exec',
          'resume',
          ...codexOptions(attempt),
          '--',
          sessionId,
          prompt,
        ],
      };
    case 'opencode':
    case 'mimo': {
      const command = (session: string[], prompt: string) => [
        cli,
        'run',
        '--format',
        'json',
        // Approves every permission the config does not deny; the sandbox is the boundary.
        cli === 'opencode' ? '--auto' : '--dangerously-skip-permissions',
        '-m',
        `${OPENCODE_PROVIDER}/${attempt.model}`,
        ...session,
        '--',
        prompt,
      ];
      return {
        command: command([], attempt.prompt),
        env: opencodeEnv(attempt, cli),
        resume: (sessionId, prompt) => command(['--session', sessionId], prompt),
      };
    }
  }
}

function claudeCommand(attempt: SandboxAttempt, session: string[], prompt: string): string[] {
  return [
    'claude',
    '--print',
    ...session,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    // A team member keeps its session on disk: a conflict resumes it once.
    ...(attempt.team ? [] : ['--no-session-persistence']),
    '--model',
    attempt.model,
    '--effort',
    attempt.effort,
    // Scheduling tools keep a headless CLI alive after its turn ends.
    '--disallowedTools',
    'ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor,RemoteTrigger,PushNotification',
    '--',
    prompt,
  ];
}

/** Placeholders only: SandboxOutbound replaces the credential on each request. */
function claudeEnv(attempt: SandboxAttempt): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: attempt.model_base,
    ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_KEY,
    // Every model alias maps to the run's model, so Claude Code never calls a Claude model.
    ANTHROPIC_MODEL: attempt.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: attempt.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: attempt.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: attempt.model,
    CLAUDE_CODE_SUBAGENT_MODEL: attempt.model,
    CLAUDE_CODE_EFFORT_LEVEL: attempt.effort,
    // Z.ai's Claude Code guide (docs.z.ai/devpack/tool/claude) sets this request timeout.
    API_TIMEOUT_MS: '3000000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // Claude Code allows --dangerously-skip-permissions as root only in a sandbox.
    IS_SANDBOX: '1',
  };
}

/** A TOML value for `codex -c key=value` (JSON strings are valid TOML basic strings). */
const toml = (value: string) => JSON.stringify(value);

/**
 * Codex CLI 0.164.0 `exec` options. Codex speaks only the OpenAI Responses API, so the run's
 * OpenAI connection is its one provider, declared inline (nothing is written to CODEX_HOME).
 */
function codexOptions(attempt: SandboxAttempt): string[] {
  const provider = `{name=${toml('YonedaRepo run connection')},base_url=${toml(modelApi(attempt).baseURL)},env_key="YONEDA_MODEL_KEY",wire_api="responses"}`;
  return [
    '--json',
    // The Cloudflare Sandbox is the isolation; Codex's own Linux sandbox cannot nest in it.
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    // A team member keeps its thread on disk: a conflict resumes it once.
    ...(attempt.team ? [] : ['--ephemeral']),
    '-m',
    attempt.model,
    '-c',
    'model_provider="yoneda"',
    '-c',
    `model_providers.yoneda=${provider}`,
    '-c',
    `model_reasoning_effort=${toml(attempt.effort)}`,
    // No update check, product analytics, feedback upload or OpenAI-hosted web search: the
    // sandbox reaches only the model endpoint and its repository.
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'analytics.enabled=false',
    '-c',
    'feedback.enabled=false',
    '-c',
    'web_search="disabled"',
  ];
}

/** opencode's provider id for the run's connection (`-m <id>/<model>`). */
const OPENCODE_PROVIDER = 'yoneda';

/**
 * opencode and MiMo Code take their whole config from the environment (OPENCODE_* and, in the
 * fork, MIMOCODE_*): the run's connection as the only provider, its model also the "small"
 * model for titles, and nothing that downloads at run time.
 */
function opencodeEnv(attempt: SandboxAttempt, cli: SandboxCli): Record<string, string> {
  const api = modelApi(attempt);
  const model = `${OPENCODE_PROVIDER}/${attempt.model}`;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    model,
    small_model: model,
    enabled_providers: [OPENCODE_PROVIDER],
    provider: {
      [OPENCODE_PROVIDER]: {
        npm: api.npm,
        name: 'YonedaRepo run connection',
        options: { baseURL: api.baseURL, apiKey: PLACEHOLDER_KEY },
        models: { [attempt.model]: { name: attempt.model } },
      },
    },
  };
  const prefix = cli === 'mimo' ? 'MIMOCODE' : 'OPENCODE';
  return {
    [`${prefix}_CONFIG_CONTENT`]: JSON.stringify(config),
    // The repository is untrusted: its own opencode config never replaces the provider.
    [`${prefix}_DISABLE_PROJECT_CONFIG`]: '1',
    [`${prefix}_DISABLE_AUTOUPDATE`]: '1',
    [`${prefix}_DISABLE_MODELS_FETCH`]: '1',
    [`${prefix}_DISABLE_LSP_DOWNLOAD`]: '1',
    [`${prefix}_DISABLE_DEFAULT_PLUGINS`]: '1',
    // MiMo Code's scheduling tool would keep the headless CLI alive after its turn ends.
    ...(cli === 'mimo' ? { MIMOCODE_DISABLE_CRON: '1', MIMOCODE_DISABLE_SHARE: '1' } : {}),
  };
}
