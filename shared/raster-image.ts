/** Bounded raster formats shared by repository previews and their HTTP adapter. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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
