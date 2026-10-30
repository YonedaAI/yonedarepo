// One workspace's managed agents (a personal account or an org), in a SQLite Durable Object:
// each agent's stored overrides for the workspace and for single repositories, and the index
// of repositories it is enabled on (each repository's RepoAgents holds the switch runs obey).
import { DurableObject } from 'cloudflare:workers';
import type { ManagedAgentId } from '../../shared/managed-agents';
import type { SettingsOverrides } from '../../shared/managed-settings';
import type { ManagedEnv } from './config';
import { migrate, WORKSPACE_SCHEMA } from './schema';

/** The workspace-wide scope; a repository scope is its id. */
export const WORKSPACE_SCOPE = '';

export interface StoredSettings {
  workspace: SettingsOverrides;
  repos: Record<string, SettingsOverrides>;
  enabled: string[];
  updated_at: number | null;
}

export class WorkspaceAgents extends DurableObject<ManagedEnv> {
  constructor(ctx: DurableObjectState, env: ManagedEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql, WORKSPACE_SCHEMA));
    });
  }

  get #sql() {
    return this.ctx.storage.sql;
  }

  settings(agent: ManagedAgentId): StoredSettings {
    const rows = this.#sql
      .exec<{ scope: string; overrides: string; updated_at: number }>(
        'SELECT scope, overrides, updated_at FROM settings WHERE agent = ?',
        agent,
      )
      .toArray();
    const out: StoredSettings = { workspace: {}, repos: {}, enabled: [], updated_at: null };
    for (const row of rows) {
      const overrides = JSON.parse(row.overrides) as SettingsOverrides;
      if (row.scope === WORKSPACE_SCOPE) out.workspace = overrides;
      else out.repos[row.scope] = overrides;
      out.updated_at = Math.max(out.updated_at ?? 0, row.updated_at);
    }
    out.enabled = this.enabledRepos(agent);
    return out;
  }

  save(agent: ManagedAgentId, scope: string, overrides: SettingsOverrides, by: string) {
    if (Object.keys(overrides).length === 0) {
      this.#sql.exec('DELETE FROM settings WHERE agent = ? AND scope = ?', agent, scope);
      return;
    }
    this.#sql.exec(
      `INSERT INTO settings (agent, scope, overrides, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent, scope) DO UPDATE SET overrides = excluded.overrides,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      agent,
      scope,
      JSON.stringify(overrides),
      Date.now(),
      by,
    );
  }

  enabledRepos(agent: ManagedAgentId): string[] {
    return this.#sql
      .exec<{ repo: string }>('SELECT repo FROM enabled WHERE agent = ? ORDER BY repo', agent)
      .toArray()
      .map((r) => r.repo);
  }

  /** The agent's set-up: who added it and when, and whether it is active (null: never). */
  meta(
    agent: ManagedAgentId,
  ): { created_by: string; created_at: number; active: boolean; all_repos: boolean } | null {
    const row = this.#sql
      .exec<{ created_by: string; created_at: number; active: number; all_repos: number }>(
        'SELECT created_by, created_at, active, all_repos FROM agent_meta WHERE agent = ?',
        agent,
      )
      .toArray()[0];
    return row ? { ...row, active: row.active === 1, all_repos: row.all_repos === 1 } : null;
  }

  /** "All repositories, including new ones": a sync connects each one the workspace gains. */
  setAllRepos(agent: ManagedAgentId, all: boolean) {
    this.#sql.exec('UPDATE agent_meta SET all_repos = ? WHERE agent = ?', all ? 1 : 0, agent);
  }

  /** Add agent: recorded once (a later save keeps who and when). */
  setUp(agent: ManagedAgentId, by: string) {
    this.#sql.exec(
      'INSERT INTO agent_meta (agent, created_by, created_at, active) VALUES (?, ?, ?, 1) ON CONFLICT(agent) DO NOTHING',
      agent,
      by,
      Date.now(),
    );
  }

  setActive(agent: ManagedAgentId, active: boolean) {
    this.#sql.exec('UPDATE agent_meta SET active = ? WHERE agent = ?', active ? 1 : 0, agent);
  }

  /** Archive: the agent's set-up, overrides and repositories are forgotten. */
  archive(agent: ManagedAgentId) {
    this.ctx.storage.transactionSync(() => {
      for (const table of ['agent_meta', 'settings', 'enabled'])
        this.#sql.exec(`DELETE FROM ${table} WHERE agent = ?`, agent);
    });
  }

  /** Repositories any agent of this workspace is set up on (paused ones included). */
  reposInUse(): string[] {
    return this.#sql
      .exec<{ repo: string }>('SELECT DISTINCT repo FROM enabled')
      .toArray()
      .map((r) => r.repo);
  }

  /** A deleted repository: out of every agent's enabled list, its own overrides dropped. */
  forget(repo: string) {
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec('DELETE FROM enabled WHERE repo = ?', repo);
      this.#sql.exec('DELETE FROM settings WHERE scope = ?', repo);
    });
  }

  /** Replaces the index of repositories `agent` is enabled on. */
  setEnabled(agent: ManagedAgentId, repos: string[]) {
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec('DELETE FROM enabled WHERE agent = ?', agent);
      for (const repo of repos)
        this.#sql.exec('INSERT INTO enabled (agent, repo) VALUES (?, ?)', agent, repo);
    });
  }
}

export const workspaceStub = (env: ManagedEnv, workspace: string) =>
  env.WORKSPACES.get(env.WORKSPACES.idFromName(workspace));
