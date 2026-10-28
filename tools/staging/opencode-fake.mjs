// A stand-in for the parts of opencode 2's plugin context the yoneda plugin uses
// (plugins/opencode/yoneda/index.ts): hook registrations the caller drives directly, a
// session's messages, and an event stream the caller feeds. No model, no opencode process.

/** `{ ctx, hooks, emit }`: pass `ctx` to the plugin's setup, call `hooks['session.context']`
 * and `hooks['tool.execute.before'|'tool.execute.after']`, and `emit` session events. */
export function fakeOpencode(directory, messages = []) {
  const hooks = {};
  const queued = [];
  let waiting;
  const events = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          queued.length
            ? Promise.resolve({ value: queued.shift(), done: false })
            : new Promise((resolve) => (waiting = (value) => resolve({ value, done: false }))),
      };
    },
  };
  return {
    hooks,
    messages,
    emit(event) {
      if (waiting) {
        const deliver = waiting;
        waiting = undefined;
        deliver(event);
      } else queued.push(event);
    },
    ctx: {
      location: { directory },
      session: {
        hook: async (name, callback) => (hooks[`session.${name}`] = callback),
        context: async () => messages,
      },
      tool: { hook: async (name, callback) => (hooks[`tool.${name}`] = callback) },
      event: { subscribe: () => events },
    },
  };
}

/** One model call's context event for `sessionID` (GLM by default). */
export const modelCall = (sessionID, model = { providerID: 'zai-coding-plan', id: 'glm-5.3' }) => ({ sessionID, model, system: [] });
