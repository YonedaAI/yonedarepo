// What every alert's words are made of: the shape of an entry, and how a number reads.

export interface Facts {
  /** Fired signals of this cause, by name. */
  values: Record<string, number | null>;
  /** The component's word (`repository`). */
  word: string;
  /** What its queue holds (`background job`). */
  noun: string;
  /** The usual p95, for a latency signal. */
  baseline?: number;
  /** What the number leaves out, in words. */
  detail?: string;
}
export interface Link {
  label: string;
  /** Under the site, or the API when `api` is set. */
  path: string;
  api?: boolean;
}
export interface Copy {
  signals: string[];
  title(f: Facts): string;
  means: string | ((f: Facts) => string);
  first: string;
  /** A different first step on these components. */
  firstOn?: Record<string, string>;
  /** The finding's own reason says more than these words: show it. */
  reason?: boolean;
  link?: (component: string) => Link;
}

export const number = (n: number) => n.toLocaleString('en-US');
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${number(n)} ${n === 1 ? one : many}`;
export const count = (f: Facts, ...names: string[]) => {
  for (const name of names) if (typeof f.values[name] === 'number') return f.values[name];
  return 0;
};
export const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
export const percent = (ratio: number) => `${Number((ratio * 100).toFixed(1))}%`;
export const duration = (ms: number) =>
  ms < 1_000
    ? `${number(ms)} ms`
    : ms < 90_000
      ? `${(ms / 1_000).toFixed(1)} s`
      : `${number(Math.round(ms / 60_000))} minutes`;
