// Contact support's browser-side checks; the server has the last word (shared/support.ts).
import {
  SUPPORT_ATTACHMENT_BYTES,
  SUPPORT_ATTACHMENT_HELP,
  SUPPORT_ATTACHMENT_TOO_LARGE,
  SUPPORT_ATTACHMENT_TYPES,
} from '../../../../shared/support';
import { ApiError } from '../../lib/api';

const TEXT_EXTENSIONS = SUPPORT_ATTACHMENT_TYPES['text/plain'];

/** The file picker's filter. */
export const ATTACHMENT_ACCEPT = [
  ...Object.keys(SUPPORT_ATTACHMENT_TYPES),
  ...TEXT_EXTENSIONS.map((extension) => `.${extension}`),
].join(',');

export const canSend = (text: string, agreed: boolean) => agreed && text.trim().length > 0;

const isTextName = (name: string) =>
  TEXT_EXTENSIONS.includes(name.split('.').pop()?.toLowerCase() ?? '') && name.includes('.');

/** Why `file` cannot be attached, or ''. */
export function attachmentProblem({
  name,
  type,
  size,
}: Pick<File, 'name' | 'type' | 'size'>): string {
  if (size > SUPPORT_ATTACHMENT_BYTES) return SUPPORT_ATTACHMENT_TOO_LARGE;
  if (!size) return 'That file is empty.';
  return isTextName(name) || type in SUPPORT_ATTACHMENT_TYPES ? '' : SUPPORT_ATTACHMENT_HELP;
}

/** The type to declare. Browsers disagree about text files (a .csv can be Excel's), so those
 * declare none and the server reads their bytes. */
export const attachmentType = ({ name, type }: Pick<File, 'name' | 'type'>) =>
  isTextName(name) ? '' : type;

/** The file's content as base64, as the request carries it. */
export const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });

/** What the dialog says about a send that failed. */
export function sendFailure(failure: unknown) {
  if (!(failure instanceof ApiError))
    return 'Your message was not sent. Check your connection and try again.';
  return failure.code === 'REQUEST_TIMEOUT'
    ? 'Sending took too long. Try again; your message is still here.'
    : failure.message;
}
