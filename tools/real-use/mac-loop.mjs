// Real Git from this machine during a run: clone, commit, push, fetch on one repository at a
// time, every `every_s`. One client, so it says what Git feels like, not how much the platform
// holds. This machine's location is whatever Cloudflare reports for it, not one of the regions.
import { gitSession } from '../fanout-bench/mac-git.mjs';

export function macGitLoop({ api, repos, tokens, every_s, random }) {
  return async ({ wait, stopping, note }) => {
    const row = (label, r) => note({ label, region: 'mac', kind: 'mac-git', who: 'agent', started_at: Date.now() - r.ms, status: r.ok ? 200 : 0, ok: r.ok, ms: r.ms, server: null, error: r.ok ? undefined : 'GIT', message: r.ok ? undefined : r.tail.slice(-120) });
    for (let turn = 0; !stopping(); turn++) {
      const at = Math.floor(random() * repos.length);
      const session = gitSession(tokens[at], api);
      try {
        const cwd = `${session.dir}/work`;
        const clone = await session.git(['clone', '-q', `${api}/git/${repos[at].id}.git`, 'work']);
        row('clone.mac', clone);
        if (clone.ok) {
          await session.git(['commit', '-q', '--allow-empty', '-m', `mac ${turn}`], cwd);
          row('push.mac', await session.git(['push', '-q', 'origin', `HEAD:refs/heads/mac/${Date.now()}`], cwd));
          row('clone.mac-fetch', await session.git(['fetch', '-q', 'origin'], cwd));
        }
      } finally {
        session.close();
      }
      await wait(every_s * 1000);
    }
  };
}
