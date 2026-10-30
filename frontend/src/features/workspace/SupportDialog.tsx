// Contact support: a message and one optional file, sent with `POST /api/v1/support`. The
// server takes the reply address from the account and says which it used. A failed send
// keeps everything in place; focus stays in the dialog as buttons disable and the form goes.
import { Paperclip, X } from 'lucide-react';
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import { fileSize, SUPPORT_MESSAGE_LIMIT } from '../../../../shared/support';
import { Dialog } from '../../components/Dialog';
import { api } from '../../lib/api';
import {
  ATTACHMENT_ACCEPT,
  attachmentProblem,
  attachmentType,
  canSend,
  readBase64,
  sendFailure,
} from './supportModel';

/** Longer than the API's default: the request can carry a 5 MB file up a slow connection. */
const SEND_TIMEOUT_MS = 90_000;

export function SupportDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const attach = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (sentTo) closeButton.current?.focus();
    else if (error) sendButton.current?.focus();
  }, [sentTo, error]);

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = ''; // the same file can be chosen again
    if (!chosen) return;
    const problem = attachmentProblem(chosen);
    setFileError(problem);
    setFile(problem ? null : chosen);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || !canSend(text, agreed)) return;
    setBusy(true);
    setError('');
    try {
      const attachment = file && {
        name: file.name,
        type: attachmentType(file),
        data: await readBase64(file),
      };
      const { email } = await api<{ email: string }>(
        'v1/support',
        { message: text, page: window.location.href, ...(attachment && { attachment }) },
        { timeout: SEND_TIMEOUT_MS },
      );
      setSentTo(email);
    } catch (failure) {
      setError(sendFailure(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Contact support" onClose={onClose} locked={busy} initialFocus="textarea">
      {sentTo ? (
        <div>
          <p role="status" className="support-status">
            Sent. We'll reply to {sentTo}.
          </p>
          <div className="support-actions">
            <button ref={closeButton} type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <form className="support-form" onSubmit={send}>
          <p>Tell us what's going on. We'll reply to the email on your account.</p>
          <textarea
            aria-label="Your message"
            placeholder="What's going on?"
            rows={8}
            maxLength={SUPPORT_MESSAGE_LIMIT}
            required
            readOnly={busy}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="support-attachment">
            <input
              ref={picker}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              hidden
              aria-label="File to attach"
              onChange={choose}
            />
            <button
              ref={attach}
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => picker.current?.click()}
            >
              <Paperclip size={15} aria-hidden="true" />
              Attach file
            </button>
            {file && (
              <span className="support-file">
                <span>{file.name}</span>
                <small>{fileSize(file.size)}</small>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${file.name}`}
                  disabled={busy}
                  onClick={() => {
                    setFile(null);
                    attach.current?.focus();
                  }}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </span>
            )}
          </div>
          {fileError && (
            <p role="alert" className="form-error">
              {fileError}
            </p>
          )}
          <div className="support-consent">
            <label>
              <input
                type="checkbox"
                required
                checked={agreed}
                disabled={busy}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              I agree to be contacted about this request.
            </label>
            <a href="/privacy" target="_blank" rel="noopener">
              Privacy Policy
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="support-actions">
            <button type="button" className="quiet" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button ref={sendButton} type="submit" disabled={busy || !canSend(text, agreed)}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
