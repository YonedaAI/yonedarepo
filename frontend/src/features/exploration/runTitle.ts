/** Compact display label; the approved brief remains unchanged. */
export function runTitle(intent: string): string {
  const firstLine = intent.trim().split(/\r?\n/u, 1)[0].replace(/\s+/gu, ' ');
  const sentence = firstLine.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? firstLine;
  const title = sentence.replace(/[.!?]$/u, '') || 'Development run';
  const characters = Array.from(title);
  if (characters.length <= 90) return title;
  const excerpt = characters.slice(0, 87).join('');
  return `${excerpt.replace(/\s+\S*$/u, '').trimEnd()}…`;
}
