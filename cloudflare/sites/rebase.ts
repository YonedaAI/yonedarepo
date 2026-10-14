//! A site is served below a path prefix (`/v/<digest>/<token>/` or `/p/<name>/`) on a shared
//! origin, so root-relative references such as `/style.css` would escape it and 404. Agents
//! and starters commonly write them, so served text re-anchors them to the hosting prefix.
//! Protocol-relative (`//host`) and absolute URLs are left untouched.
const rules: Record<string, RegExp[]> = {
  html: [/(\s(?:src|href|action|poster)\s*=\s*["']?)\/(?!\/)/gi],
  css: [/(url\(\s*["']?)\/(?!\/)/gi, /(@import\s+["'])\/(?!\/)/gi],
  js: [/(\bfrom\s*["'])\/(?!\/)/g, /(\bimport\s*\(\s*["'])\/(?!\/)/g, /(\bimport\s+["'])\/(?!\/)/g],
};
rules.htm = rules.html;
rules.mjs = rules.js;

export function rebase(extension: string, content: string, prefix: string): string {
  const patterns = rules[extension];
  if (!patterns) return content;
  return patterns.reduce((text, pattern) => text.replace(pattern, `$1${prefix}`), content);
}
