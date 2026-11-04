// A README's relative images, read through the same API as the file and only from its own
// repository at its own revision. The bytes become a `blob:` URL an `<img>` shows, so nothing is
// fetched from anywhere a file names and no request carries a path the viewer could not read.
// Only raster formats whose first bytes say so: an SVG can carry script, and a `blob:` URL
// opened in its own tab would run it on this origin.

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;

export { imageType, MAX_IMAGE_BYTES } from '../../../../shared/raster-image';

/** The repository path `src` names from a Markdown file at `file`, or null when it is anything
 * but a relative path to an image inside the repository. */
export function repoImagePath(file: string, src: string): string | null {
  const bare = src.split(/[?#]/)[0];
  if (!bare || bare.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a path holds none of these.
  if (/[\\\x00-\x1f]/.test(decoded) || !IMAGE.test(decoded)) return null;
  const parts = decoded.startsWith('/') ? [] : file.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/') || null;
}
