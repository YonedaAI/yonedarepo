/** Splits a recorded agent summary into its opening sentence and the remaining detail, verbatim. */
export function splitRationale(text: string): { lead: string; detail: string } {
  const trimmed = text.trim();
  const match = /^(.+?[.!?])(\s+)(?=\S)/s.exec(trimmed);
  if (!match) return { lead: trimmed, detail: '' };
  return { lead: match[1], detail: trimmed.slice(match[0].length) };
}
