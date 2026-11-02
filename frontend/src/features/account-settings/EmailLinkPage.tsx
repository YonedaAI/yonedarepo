// The page an account email's link opens (emailLinkRoute.ts).
import type { EmailLinkRoute } from './emailLinkRoute';
import { ResetPasswordPage } from './ResetPasswordPage';
import { VerifyEmailPage } from './VerifyEmailPage';

export function EmailLinkPage({ route }: { route: EmailLinkRoute }) {
  const { account, token } = route;
  return route.view === 'verify-email' ? (
    <VerifyEmailPage account={account} token={token} />
  ) : (
    <ResetPasswordPage account={account} token={token} />
  );
}
