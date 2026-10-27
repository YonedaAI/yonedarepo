// The stock CLIs' command lines, environments and model endpoints, and the egress that follows.
import { describe, expect, it } from 'vitest';
import type { SandboxAttempt } from '../../cloudflare/worker/sandbox-attempt';
import { agentCli, modelPaths } from '../../cloudflare/worker/sandbox-cli';
import { type AgentEgress, outboundDecision } from '../../cloudflare/worker/sandbox-outbound';

const attempt = (patch: Partial<SandboxAttempt>): SandboxAttempt =>
  ({
    provider: 'zai',
    model: 'glm-5.3-flash',
    model_base: 'https://api.z.ai/api/anthropic',
    effort: 'low',
    prompt: '-Add add(a,b)',
    ...patch,
  }) as SandboxAttempt;
const env = (value: SandboxAttempt) => JSON.stringify(agentCli(value).env);

describe('sandbox CLIs', () => {
  it('runs Codex CLI headless against the run connection, resuming its thread', () => {
    const codex = attempt({
      cli: 'codex',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      model_base: 'https://api.openai.com',
    });
    const cli = agentCli(codex);
    expect(cli.command.slice(0, 3)).toEqual(['codex', 'exec', '--json']);
    expect(cli.command).toContain('--ephemeral');
    expect(cli.command).toContain(
      'model_providers.yoneda={name="YonedaRepo run connection",base_url="https://api.openai.com/v1",env_key="YONEDA_MODEL_KEY",wire_api="responses"}',
    );
    // The prompt is one argument after `--`, even when it looks like a flag.
    expect(cli.command.slice(-2)).toEqual(['--', '-Add add(a,b)']);
    expect(cli.env).toMatchObject({ YONEDA_MODEL_KEY: 'provided-by-worker' });
    const resume = agentCli({ ...codex, team: { branch: 'attempts/r/team' } }).resume('t-1234567', 'fix');
    expect(resume.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
    expect(resume).not.toContain('--ephemeral');
    expect(resume.slice(-3)).toEqual(['--', 't-1234567', 'fix']);
    expect(modelPaths(codex)).toEqual(['/v1/responses']);
  });

  it('runs opencode with the connection as its only provider, from the environment', () => {
    const opencode = attempt({ cli: 'opencode' });
    const cli = agentCli(opencode);
    expect(cli.command).toEqual([
      'opencode',
      'run',
      '--format',
      'json',
      '--auto',
      '-m',
      'yoneda/glm-5.3-flash',
      '--',
      '-Add add(a,b)',
    ]);
    expect(cli.resume('ses_abc12345', 'fix')).toContain('--session');
    const config = JSON.parse(cli.env.OPENCODE_CONFIG_CONTENT);
    expect(config).toMatchObject({
      autoupdate: false,
      share: 'disabled',
      model: 'yoneda/glm-5.3-flash',
      small_model: 'yoneda/glm-5.3-flash',
      enabled_providers: ['yoneda'],
    });
    expect(config.provider.yoneda).toMatchObject({
      npm: '@ai-sdk/anthropic',
      options: { baseURL: 'https://api.z.ai/api/anthropic/v1', apiKey: 'provided-by-worker' },
    });
    expect(cli.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(modelPaths(opencode)).toEqual([
      '/api/anthropic/v1/messages',
      '/api/anthropic/v1/messages/count_tokens',
    ]);
    const gemini = attempt({
      cli: 'opencode',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      model_base: 'https://generativelanguage.googleapis.com',
    });
    expect(modelPaths(gemini)).toEqual([
      '/v1beta/models/gemini-3.8-flash:streamGenerateContent',
      '/v1beta/models/gemini-3.8-flash:generateContent',
    ]);
  });

  it("runs MiMo Code with its own env names, and MiMo models over MiMo's Chat Completions", () => {
    const mimo = attempt({
      cli: 'mimo',
      provider: 'mimo',
      model: 'mimo-v2.6-flash',
      model_base: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
    });
    const cli = agentCli(mimo);
    expect(cli.command.slice(0, 5)).toEqual([
      'mimo',
      'run',
      '--format',
      'json',
      '--dangerously-skip-permissions',
    ]);
    expect(cli.env.MIMOCODE_DISABLE_CRON).toBe('1');
    expect(cli.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(JSON.parse(cli.env.MIMOCODE_CONFIG_CONTENT).provider.yoneda).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1' },
    });
    expect(modelPaths(mimo)).toEqual(['/v1/chat/completions']);
    // Other models keep their provider's own API.
    expect(modelPaths({ ...mimo, provider: 'zai', model: 'glm-5.3' })).toHaveLength(2);
  });

  it('keeps Claude Code as it was, and the default for attempts begun before the choice', () => {
    const before = attempt({});
    expect(agentCli(before).command[0]).toBe('claude');
    expect(agentCli(before).env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(modelPaths(before)).toEqual([
      '/api/anthropic/v1/messages',
      '/api/anthropic/v1/messages/count_tokens',
    ]);
  });

  it('refuses a CLI that cannot drive the provider, and never puts a key in the sandbox', () => {
    for (const [cli, provider] of [
      ['claude', 'codex'],
      ['codex', 'zai'],
      ['claude', 'gemini'],
    ] as const)
      expect(() => agentCli(attempt({ cli, provider }))).toThrow(
        expect.objectContaining({ code: 'SANDBOX_HARNESS' }),
      );
    for (const cli of ['claude', 'opencode', 'mimo'] as const)
      expect(env(attempt({ cli }))).not.toMatch(/sk-|tp-|yrp_|ypat_/);
  });

  // Live: a resumed team member's own `git commit` failed with "Author identity unknown".
  it('gives every CLI a git identity, so its own commits work', () => {
    const runs = [
      attempt({ cli: 'claude' }),
      attempt({ cli: 'opencode' }),
      attempt({ cli: 'mimo', provider: 'mimo', model: 'mimo-v2.6-flash' }),
      attempt({ cli: 'codex', provider: 'codex', model: 'gpt-5.6-luna', model_base: 'https://api.openai.com' }),
    ];
    for (const run of runs)
      expect(agentCli(run).env).toMatchObject({
        GIT_AUTHOR_NAME: 'YonedaRepo agent',
        GIT_AUTHOR_EMAIL: 'agent@yonedarepo.invalid',
        GIT_COMMITTER_NAME: 'YonedaRepo agent',
        GIT_COMMITTER_EMAIL: 'agent@yonedarepo.invalid',
      });
  });
});

describe('model egress per CLI', () => {
  const egress = (value: SandboxAttempt): AgentEgress => ({
    project: 'proj',
    owner: 'owner',
    platformRepo: 'r0123456789abcdef0123',
    platformOrigin: 'https://dev.yonedarepo.com',
    ref: 'refs/heads/attempts/run-1/1',
    provider: value.provider,
    model: value.model,
    modelBase: value.model_base,
    modelPaths: modelPaths(value),
  });

  it('opens only the paths the run CLI posts model requests to', () => {
    const codex = egress(
      attempt({ cli: 'codex', provider: 'codex', model: 'gpt-5.6-luna', model_base: 'https://api.openai.com' }),
    );
    const decide = (props: AgentEgress, url: string, method = 'POST') =>
      outboundDecision(new URL(url), method, props);
    expect(decide(codex, 'https://api.openai.com/v1/responses')).toEqual({ route: 'model' });
    expect(decide(codex, 'https://api.openai.com/v1/responses', 'GET')).toHaveProperty('deny');
    for (const path of ['/v1/chat/completions', '/v1/files', '/v1/responses/x', '/v1/realtime'])
      expect(decide(codex, `https://api.openai.com${path}`)).toHaveProperty('deny');
    const gemini = egress(
      attempt({
        cli: 'opencode',
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        model_base: 'https://generativelanguage.googleapis.com',
      }),
    );
    expect(
      decide(gemini, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'),
    ).toEqual({ route: 'model' });
    // Another model of the same key is out of reach.
    expect(
      decide(gemini, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent'),
    ).toHaveProperty('deny');
    const mimo = egress(
      attempt({ cli: 'mimo', provider: 'mimo', model: 'mimo-v2.6-flash', model_base: 'https://api.xiaomimimo.com/anthropic' }),
    );
    expect(decide(mimo, 'https://api.xiaomimimo.com/v1/chat/completions')).toEqual({ route: 'model' });
    expect(decide(mimo, 'https://api.xiaomimimo.com/anthropic/v1/messages')).toHaveProperty('deny');
  });
});
