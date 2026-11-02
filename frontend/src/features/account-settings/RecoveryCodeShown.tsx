// A new recovery code, shown once: right after sign-up, a reset, or regenerating it in Settings.
// It lives in the caller's state only and is gone with the page.
import { CopyBlock } from '../source-platform/TokenParts';

export function RecoveryCodeShown({ code }: { code: string }) {
  return (
    <>
      <p>This code resets your password. Store it somewhere private; it is shown once.</p>
      <CopyBlock label="recovery code" text={code} />
    </>
  );
}
