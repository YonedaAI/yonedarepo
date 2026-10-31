// Contact support's limits and attachment types: the browser checks them to answer early, and
// the server (cloudflare/worker/platform-support.ts) decides.

export const SUPPORT_MESSAGE_LIMIT = 5_000;
export const SUPPORT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Attachment types and their file extensions; the first names a file with another. */
export const SUPPORT_ATTACHMENT_TYPES: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'log', 'md', 'csv'],
};
/** What browsers call a text file ('' when they don't know); every one is sent as text/plain. */
export const SUPPORT_TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', ''];
export const SUPPORT_ATTACHMENT_HELP =
  'Attach a PNG, JPEG, GIF or WebP image, a PDF or a text file.';
export const SUPPORT_ATTACHMENT_TOO_LARGE = 'An attachment can be up to 5 MB.';

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
