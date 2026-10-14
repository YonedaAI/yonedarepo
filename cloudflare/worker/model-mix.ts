import { providerDefinition } from '../../shared/providers';
import type { Json } from './types';

/** Owner-approved model groups for team slots: task-owning slots use `specialists`; the
 * planner, integrator and coordinator use `coordination`. Never substitutes another model. */
export interface ModelMix {
  specialists: { provider: string; model: string };
  coordination: { provider: string; model: string };
}
interface PoolMember {
  connection: string;
  provider: string;
  model: string;
}

const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_INPUT' });
const group = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Json).provider === 'string' &&
  typeof (value as Json).model === 'string';

export function parseModelMix(value: unknown): ModelMix | undefined {
  if (value === undefined) return undefined;
  if (!group((value as Json)?.specialists) || !group((value as Json)?.coordination))
    throw invalid('A model mix names one specialist and one coordination model.');
  const { specialists, coordination } = value as ModelMix;
  return {
    specialists: { provider: specialists.provider, model: specialists.model },
    coordination: { provider: coordination.provider, model: coordination.model },
  };
}

function label(entry: { provider: string; model: string }) {
  try {
    const definition = providerDefinition(entry.provider);
    const model = definition.models.find((candidate) => candidate.id === entry.model);
    return `${definition.name} ${model?.label ?? entry.model}`;
  } catch {
    return `${entry.provider} ${entry.model}`;
  }
}

/** Resolves both groups to saved, priced pool connections or fails before any run starts. */
export function resolveModelMix<T extends PoolMember>(mix: ModelMix, pool: T[]) {
  const find = (entry: { provider: string; model: string }) => {
    const member = pool.find((m) => m.provider === entry.provider && m.model === entry.model);
    if (!member)
      throw Object.assign(
        new Error(
          `Connect ${label(entry)} before starting; this guide never substitutes another model.`,
        ),
        { code: 'PROVIDER_MISSING' },
      );
    return member;
  };
  return { specialists: find(mix.specialists), coordination: find(mix.coordination) };
}

/** A fixed plan's slot is a specialist exactly when it owns a task. */
export function ownsTask(team: Json, index: number) {
  return Array.isArray(team?.tasks) && team.tasks.some((task: Json) => task?.agent === index);
}
