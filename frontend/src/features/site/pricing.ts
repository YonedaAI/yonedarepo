// Preview pricing: every rate, allowance and credit the pricing page shows, in one place.
// Billing is not built yet; the page says so. Every platform feature is free; only what we
// run for an account is metered, at Cloudflare's list cost × MARGIN, rounded up.
//
// Cloudflare list prices, Workers Paid plan, read 2026-10-28:
// - Containers (https://developers.cloudflare.com/containers/pricing/): memory
//   $0.0000025 per GiB-second, CPU $0.000020 per vCPU-second (active use only), disk
//   $0.00000007 per GB-second; egress $0.025/GB in North America and Europe ($0.04–0.05
//   elsewhere). Checks run on `standard-1`: 1/2 vCPU, 4 GiB, 8 GB (cloudflare/wrangler.*-platform.jsonc).
// - Artifacts (https://developers.cloudflare.com/artifacts/platform/pricing/): storage
//   $0.50 per GB-month (billing begins 2026-11-12).
// - R2 (https://developers.cloudflare.com/r2/pricing/): Standard storage $0.015 per GB-month;
//   egress free.
// - Durable Objects (https://developers.cloudflare.com/durable-objects/platform/pricing/):
//   SQLite stored data $0.20 per GB-month.
// - Workers (https://developers.cloudflare.com/workers/platform/pricing/): no egress charge.
//
// Requests, CPU, Durable Object calls and R2 operations are not metered: they are part of
// the free platform.

/** Price = Cloudflare cost × MARGIN, rounded up by `roundUpClean`, unless `price` is set. */
export const MARGIN = 1.3;

const CHECK_INSTANCE = { vcpu: 0.5, memoryGiB: 4, diskGB: 8 }; // standard-1
const CONTAINER = { perGiBSecond: 0.0000025, perVcpuSecond: 0.00002, perGBSecond: 0.00000007 };

export type Meter = {
  id: string;
  label: string;
  /** What one unit is, as the page prints it after the rate. */
  unit: string;
  /** What is metered, in a sentence. */
  detail: string;
  /** Cloudflare's list cost per unit, in USD. */
  cost: number;
  /** Where `cost` comes from, as the page prints it (the sources are cited above). */
  basis: string;
  /** The free allowance per account, as printed; absent when every unit is metered. */
  included?: string;
  /** A hand-set price per unit, in USD, overriding cost × MARGIN. */
  price?: number;
};

export const METERS: Meter[] = [
  {
    id: 'check-minutes',
    label: 'Check minutes',
    unit: 'minute',
    detail: 'Wall-clock time of each check container, billed per second of a run.',
    // CPU counted as fully busy for the whole minute: an upper bound on what Cloudflare bills.
    cost:
      60 *
      (CHECK_INSTANCE.memoryGiB * CONTAINER.perGiBSecond +
        CHECK_INSTANCE.vcpu * CONTAINER.perVcpuSecond +
        CHECK_INSTANCE.diskGB * CONTAINER.perGBSecond),
    basis: 'Container compute list price: 1/2 vCPU, 4 GiB memory, 8 GB disk',
  },
  {
    id: 'git-storage',
    label: 'Git storage',
    unit: 'GB-month',
    detail: 'Commits, trees and files, with a second copy for fast reads.',
    cost: 0.5 + 0.015,
    basis: 'Git object storage plus object-storage copy, list price',
    included: '1 GB',
  },
  {
    id: 'log-storage',
    label: 'Transaction log and metadata',
    unit: 'GB-month',
    detail: "Each repository's log, refs, reviews, sessions and settings.",
    cost: 0.2,
    basis: 'Durable SQLite storage list price',
    included: '1 GB',
  },
  {
    id: 'large-files',
    label: 'LFS objects and release assets',
    unit: 'GB-month',
    detail: 'Git LFS files and the files attached to releases.',
    cost: 0.015,
    basis: 'Object storage list price',
    included: '5 GB',
  },
  {
    id: 'egress',
    label: 'Egress',
    unit: 'GB',
    detail: 'Bytes served to clones, fetches, downloads and the API.',
    // Workers and R2 list egress as free; the Containers rate is Cloudflare's per-GB list price.
    cost: 0.025,
    basis: 'Container egress list price, North America and Europe',
    included: '100 GB a month',
  },
];

export const PRICING = {
  /** Credit on a new account; no card is asked for. */
  startingCreditUsd: 5,
  /** Automatic top-up: when the balance falls below `belowUsd`, add `addUsd`. */
  topUp: { belowUsd: 5, addUsd: 20 },
  /** Where Enterprise enquiries go (a `mailto:` or https URL); none is published yet. */
  enterpriseContact: null as string | null,
};

/** Rounds up to two significant figures: 0.0016037 → 0.0017, 0.6695 → 0.67. */
export function roundUpClean(value: number): number {
  if (value <= 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(value)) - 1);
  // The tolerance keeps float noise (0.26000000000000001) from rounding up a whole step.
  return Number((Math.ceil(value / step - 1e-9) * step).toPrecision(2));
}

export const meterPrice = (meter: Meter) => meter.price ?? roundUpClean(meter.cost * MARGIN);

/** `$5`, `$0.20`, `$0.0017`: whole dollars bare, otherwise cents or every significant digit. */
export function formatUsd(value: number): string {
  if (Number.isInteger(value)) return `$${value}`;
  const decimals = String(Number(value.toPrecision(6))).split('.')[1]?.length ?? 0;
  return `$${value.toFixed(Math.max(2, decimals))}`;
}
