import { providerDefinition } from '../../shared/providers';
import type { Json } from './types';

export type MiMoRegion = 'cn' | 'sgp' | 'ams';
export type MiMoRouting = { plan: 'api_credits' } | { plan: 'token_plan'; region: MiMoRegion };

/** Normalize legacy API connections, reject unknown hosts and keep region choice explicit. */
export function mimoRouting(provider: string, value?: Json | null): MiMoRouting | undefined {
  if (provider !== 'mimo') {
    if (value != null) throw new Error('Plan routing is only available for MiMo');
    return undefined;
  }
  if (value == null) return { plan: 'api_credits' };
  if (value.plan === 'api_credits' && Object.keys(value).length === 1)
    return { plan: 'api_credits' };
  if (
    value.plan === 'token_plan' &&
    ['cn', 'sgp', 'ams'].includes(value.region) &&
    Object.keys(value).length === 2
  )
    return { plan: 'token_plan', region: value.region };
  throw new Error('Choose API credits or Token Plan with its documented region');
}

export function mimoUpstream(value?: Json | null) {
  const route = mimoRouting('mimo', value);
  const definition = providerDefinition('mimo');
  if (route?.plan !== 'token_plan') return definition.api_base;
  const upstream = definition.token_plan_regions?.[route.region];
  if (!upstream) throw new Error('Token Plan region is not configured');
  return upstream;
}

export function validateMiMoKey(provider: string, key: string, routing?: Json | null) {
  const route = mimoRouting(provider, routing);
  if (!route) return;
  const tokenPlan = /^(tp-|ttp-)/.test(key);
  if (route.plan === 'token_plan' && !tokenPlan)
    throw Object.assign(new Error('Token Plan requires its dedicated tp- or ttp- key'), {
      code: 'PROVIDER_CONFIGURATION',
    });
  if (route.plan === 'api_credits' && tokenPlan)
    throw Object.assign(new Error('This is a Token Plan key. Select Token Plan and its region.'), {
      code: 'PROVIDER_CONFIGURATION',
    });
}
