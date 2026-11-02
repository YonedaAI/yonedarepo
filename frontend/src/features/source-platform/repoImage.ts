// A README's relative images, read through the same API as the file and only from its own
// repository at its own revision. The bytes become a `blob:` URL an `<img>` shows, so nothing is
// fetched from anywhere a file names and no request carries a path the viewer could not read.
// Only raster formats whose first bytes say so: an SVG can carry script, and a `blob:` URL
// opened in its own tab would run it on this origin.

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
/** More than a README's picture needs, and held whole in memory. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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

const starts = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));

/** The type of a raster image by its first bytes, whatever its name says; null for anything else. */
export function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && starts(bytes, 1, 'PNG\r\n')) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (starts(bytes, 0, 'GIF8')) return 'image/gif';
  if (starts(bytes, 0, 'RIFF') && starts(bytes, 8, 'WEBP')) return 'image/webp';
  if (starts(bytes, 4, 'ftypavi')) return 'image/avif';
  return null;
}
