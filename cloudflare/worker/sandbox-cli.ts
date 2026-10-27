// The coding CLI a sandbox runs, unmodified and headless. Only the command lines (start, and
// resume of a session) and the environment are CLI-specific; the sandbox, activity log,
// push, landing and recording are shared.
// Claude Code is the one implemented CLI (Z.ai GLM and MiMo speak its Anthropic protocol);
// Codex CLI (`codex exec --json`) is added here as another `AgentCli` when a run needs it.
import type { SandboxAttempt } from './sandbox-attempt';

export type AgentCli = {
  command: string[];
  env: Record<string, string>;
  /** The same CLI session continued with `prompt` (a team member's one conflict resume). */
  resume(sessionId: string, prompt: string): string[];
};

export function agentCli(attempt: SandboxAttempt): AgentCli {
  if (attempt.harness !== 'claude')
    throw Object.assign(new Error(`Sandbox runs support Claude Code, not ${attempt.harness}`), {
      code: 'SANDBOX_HARNESS',
    });
  return {
    command: claudeCommand(attempt, [], attempt.prompt),
    env: claudeEnv(attempt),
    resume: (sessionId, prompt) => claudeCommand(attempt, ['--resume', sessionId], prompt),
  };
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
    ANTHROPIC_AUTH_TOKEN: 'provided-by-worker',
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
