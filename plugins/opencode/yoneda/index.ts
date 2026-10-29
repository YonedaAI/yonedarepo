// YonedaRepo plugin for opencode 2 (the plugin API of `@opencode/plugin`: a default export
// with an `id` and `setup(ctx)`; no imports from it, so it loads without a package install).
// In a clone with a YonedaRepo remote it does what the Claude Code plugin's hooks do, through
// `yoneda hook opencode-<event>` (backend/crates/yoneda-cli/src/opencode_hook.rs):
//   - session context hook: the first model call of each session gets the repository's
//     context (`yoneda context`: landing rules, recent sessions, open changes, contracts)
//     as a system part; later calls reuse it
//   - tool execute.after (read, grep, glob): the files read become the next push's
//     declared reads, and the memories and contracts anchored there that the session has
//     not been shown yet are added to its next model calls (`opencode-read` prints them)
//   - each new user prompt (seen on the next model call): what is relevant to its words and
//     not shown yet is added the same way (`opencode-prompt`)
//   - tool execute.after of git_memory_add: noted, so the session's summary is offered as
//     a draft memory when its run ends
//   - tool execute.before (shell): a plain `git push` over smart HTTP while reads are
//     recorded is refused with the `yoneda push` that declares them (a yoneda:: remote's
//     helper declares them itself)
//   - session execution ended (and plugin cleanup): a session record (cli opencode, the
//     session's model, the last assistant text as summary, and the transcript: the
//     session's messages, prompts, tool calls with their input and output, and replies,
//     with the context it started with) on each commit the session pushed. opencode runs
//     shell commands with OPENCODE_SESSION_ID, so pushes are noted under
//     `opencode:<sessionID>`.
// Outside such a clone, or without the yoneda CLI on PATH, it does nothing. A hook failure
// never blocks the session (only a push refusal does, by design).
// With YONEDA_AGENT_WORKDIR set (the staging kit's agent sandbox), a session whose directory
// is anything else is refused every tool call and model call: opencode takes its directory
// from $PWD, so a wrong one means the agent would work in someone else's checkout.
// Install: `yoneda setup opencode` (this file to ~/.config/opencode/plugins/yoneda/, the
// MCP server into opencode.json), or see ../AGENTS.md.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

type Json = Record<string, unknown>;
type Message = {
  type?: string;
  text?: string;
  model?: { providerID?: string; id?: string };
  content?: { type?: string; text?: string }[];
  info?: Message;
};
// The parts of the plugin context this plugin uses (`@opencode/plugin` Context).
type Context = {
  location: { directory: string };
  session: {
    hook: (
      name: 'context',
      callback: (event: {
        sessionID: string;
        model: { providerID: string; id: string };
        system: { type: 'text'; text: string }[];
      }) => Promise<void> | void,
    ) => Promise<unknown>;
    context: (input: { sessionID: string }) => Promise<readonly Message[]>;
  };
  tool: {
    hook: (
      name: 'execute.before' | 'execute.after',
      callback: (event: {
        tool: string;
        sessionID: string;
        input: unknown;
        status?: string;
        result?: unknown;
      }) => Promise<void> | void,
    ) => Promise<unknown>;
  };
  event: {
    subscribe: (options: {
      types?: readonly string[];
      signal?: AbortSignal;
    }) => AsyncIterable<{ type: string; data?: { sessionID?: string } }>;
  };
};

const READ_TOOLS = new Set(['read', 'view', 'grep', 'glob', 'search']);
/** The platform MCP tool that adds a memory, under any server prefix opencode gives it. */
const MEMORY_TOOL = /(^|[_.])git_memory_add$/;
const SHELL_TOOLS = new Set(['shell', 'bash']);
const ENDED = ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'];
/** opencode's default when a session names no model: GLM on the Z.ai coding plan. */
export const DEFAULT_MODEL = 'zai-coding-plan/glm-5.3';

/** Appends one hook call to `$YONEDA_HOOK_LOG`, when set (what opencode passed, and what
 * the hook answered: for opencode-start, the context the session got; any stderr, which
 * opencode does not show). */
function logHook(entry: Json) {
  const log = process.env.YONEDA_HOOK_LOG;
  if (!log) return;
  try {
    appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  } catch {}
}

/** Runs `yoneda hook <event>` with `payload` on stdin; its stdout ('' on any failure). */
export async function runHook(event: string, payload: Json, timeoutMs = 20_000): Promise<string> {
  const { out, err } = await spawnHook(event, payload, timeoutMs);
  logHook({ event, payload, output: out, ...(err ? { stderr: err } : {}) });
  return out;
}

function spawnHook(event: string, payload: Json, timeoutMs: number): Promise<{ out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.env.YONEDA_BIN || 'yoneda', ['hook', event], {
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    // No yoneda on PATH: nothing to do.
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ out: '', err: '' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (err.trim()) console.error(err.trim());
      resolve({ out: out.trim(), err: err.trim() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** What a session's messages say for its record: model, last assistant text, prompts. */
export function summarise(messages: readonly Message[]) {
  let model: string | undefined;
  let summary: string | undefined;
  const prompts: string[] = [];
  for (const raw of messages) {
    const m = raw.info ?? raw;
    if (m.type === 'user' && m.text) prompts.push(m.text);
    if (m.type !== 'assistant') continue;
    if (m.model?.providerID && m.model.id) model = `${m.model.providerID}/${m.model.id}`;
    const text = (m.content ?? [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('\n')
      .trim();
    if (text) summary = text;
  }
  return { model, summary, prompts };
}

/** The text of the session's latest user prompt, if any. */
export function lastPrompt(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i].info ?? messages[i];
    if (m.type === 'user' && m.text) return m.text;
  }
  return undefined;
}

export default {
  id: 'yoneda',
  async setup(ctx: Context) {
    const cwd = ctx.location.directory;
    const pinned = process.env.YONEDA_AGENT_WORKDIR;
    if (pinned && cwd.replace(/\/$/, '') !== pinned.replace(/\/$/, '')) {
      const refusal = `yoneda: this session's directory ${cwd} is not ${pinned}; refusing to work here`;
      logHook({ event: 'opencode-guard', payload: { cwd, expected: pinned }, output: refusal });
      console.error(refusal);
      const refuse = async () => {
        throw new Error(refusal);
      };
      await ctx.session.hook('context', refuse);
      await ctx.tool.hook('execute.before', refuse);
      return async () => {};
    }
    const contexts = new Map<string, Promise<string>>();
    const models = new Map<string, string>();
    const stops = new Map<string, Promise<void>>();
    // Context added after the start (file reads, prompts), kept for every later model call.
    const injected = new Map<string, string[]>();
    const prompts = new Map<string, string>();
    const remember = (sessionID: string, text: string) => {
      if (text) injected.set(sessionID, [...(injected.get(sessionID) ?? []), text]);
    };

    await ctx.session.hook('context', async (event) => {
      models.set(event.sessionID, `${event.model.providerID}/${event.model.id}`);
      let text = contexts.get(event.sessionID);
      if (!text) {
        text = runHook('opencode-start', { sessionID: event.sessionID, cwd });
        contexts.set(event.sessionID, text);
      }
      const context = await text;
      if (context) event.system.push({ type: 'text', text: context });
      const messages = await ctx.session.context({ sessionID: event.sessionID }).catch(() => [] as Message[]);
      const prompt = lastPrompt(messages);
      if (prompt && prompts.get(event.sessionID) !== prompt) {
        prompts.set(event.sessionID, prompt);
        remember(event.sessionID, await runHook('opencode-prompt', { sessionID: event.sessionID, cwd, prompt }));
      }
      for (const added of injected.get(event.sessionID) ?? []) event.system.push({ type: 'text', text: added });
    });

    await ctx.tool.hook('execute.before', async (event) => {
      if (!SHELL_TOOLS.has(event.tool)) return;
      const reason = await runHook('opencode-shell', { tool: event.tool, input: event.input, sessionID: event.sessionID, cwd });
      if (reason) throw new Error(reason);
    });

    await ctx.tool.hook('execute.after', async (event) => {
      if (event.status === 'error') return;
      if (MEMORY_TOOL.test(event.tool)) {
        await runHook('opencode-memory', { sessionID: event.sessionID, cwd });
        return;
      }
      if (!READ_TOOLS.has(event.tool)) return;
      const added = await runHook('opencode-read', { tool: event.tool, input: event.input, result: event.result, sessionID: event.sessionID, cwd });
      remember(event.sessionID, added);
    });

    // One record pass per session at a time; a later end runs after the earlier one.
    const stop = (sessionID: string) => {
      const run = async () => {
        const messages = await ctx.session.context({ sessionID }).catch(() => [] as Message[]);
        const seen = summarise(messages);
        await runHook('opencode-stop', {
          sessionID,
          cwd,
          model: seen.model ?? models.get(sessionID) ?? DEFAULT_MODEL,
          summary: seen.summary ?? '',
          prompts: seen.prompts,
          // The hook makes the uploaded transcript from these (opencode_hook.rs).
          messages,
        });
      };
      const next = (stops.get(sessionID) ?? Promise.resolve()).then(run, run);
      stops.set(sessionID, next);
      return next;
    };

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ENDED, signal: controller.signal })) {
        const sessionID = event.data?.sessionID;
        if (sessionID) void stop(sessionID);
      }
    })().catch(() => {});

    // opencode exits right after a run ends (in the agent sandbox the container then stops and
    // kills any hook still running): finish (or make) every seen session's record, and every
    // record pass a session end started, also in an instance that saw no model call.
    return async () => {
      controller.abort();
      await Promise.allSettled([...models.keys()].map(stop));
      await Promise.allSettled([...stops.values()]);
    };
  },
};
