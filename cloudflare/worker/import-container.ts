// An import's instance: the check image on a class of its own, as only an import needs the disk
// for a 10 GB clone, and checks are priced by theirs. The only instance with the internet
// (`repo-clone`), it runs no repository's code and is destroyed like a check's.

import { Container } from '@cloudflare/containers';
import { type CheckInstance, startCheck } from './check-container';
import { type CloneParams, CloneSession, type Stage } from './repo-clone';
import { inScope } from './request-scope';
import type { Env } from './types';

/** A clone's session on `instance`: a fresh start with the internet, and a credential only
 * in that start's environment. */
export const cloneSession = (instance: CheckInstance, env: Env) =>
  new CloneSession(instance, env, (credential) =>
    startCheck(instance, {
      internet: true,
      envVars: credential ? { CLONE_CREDENTIAL: credential } : {},
    }),
  );

export class ImportContainer extends Container<Env> {
  defaultPort = 8080;
  enableInternet = false;
  sleepAfter = '2m';

  #clone: CloneSession | null = null;

  /** One step of a clone (`cloneRepository`'s Workflow calls this). An instance left idle
   * between steps is killed below, and the steps start over. */
  cloneStep(stage: Stage, params: CloneParams, credential?: string) {
    const job = { repo_id: params.repo, job_id: 'clone', kind: 'clone' };
    this.#clone ??= cloneSession(this, this.env);
    const clone = this.#clone;
    return inScope({ env: this.env, job }, () => clone.step(stage, params, credential));
  }

  /** An instance left idle (its caller vanished mid-run) is killed, not asked to stop. */
  override async onActivityExpired() {
    if (this.ctx.container?.running) await this.destroy();
  }
}
