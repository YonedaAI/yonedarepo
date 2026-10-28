// The LFS quota as the Settings form edits it: whole bytes on the wire, GiB in the form.
export type LfsUsage = {
  quota_bytes: number;
  used_bytes: number;
  stored_bytes: number;
  pending_bytes: number;
  objects: number;
  max_object_bytes: number;
  max_quota_bytes: number;
};

export const GIB = 1024 ** 3;
const UNITS = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];

/** `1.5 GiB`, `200 MiB`, `0 bytes`. */
export function formatBytes(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${UNITS[unit]}`;
}

/** The form's GiB text as bytes, or why it cannot be a quota. */
export function parseQuota(text: string, max: number): { bytes: number } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { error: 'Enter the quota in GiB, e.g. 5 or 0.5' };
  const bytes = Math.round(Number(trimmed) * GIB);
  if (bytes > max) return { error: `The largest quota is ${formatBytes(max)}` };
  return { bytes };
}

/** The quota in GiB as the form shows it (up to three decimals). */
export const quotaText = (bytes: number) => String(Math.round((bytes / GIB) * 1000) / 1000);

/** Share of the quota in use, 0-100 (100 when the quota is 0 and anything is used). */
export function usedPercent(usage: Pick<LfsUsage, 'quota_bytes' | 'used_bytes'>) {
  if (usage.quota_bytes <= 0) return usage.used_bytes > 0 ? 100 : 0;
  return Math.min(100, Math.round((usage.used_bytes / usage.quota_bytes) * 100));
}
