---
title: Accounts and sign-in
summary: Sign up with an email address or with GitHub or Google, keep your recovery code, and manage where you are signed in.
---

## Create an account

Open [yonedarepo.com/signup](/signup) and enter:

- **Email address.** It is kept private and never shown on your public account.
- **Password.** 12 to 128 characters.

Or choose **Continue with GitHub** or **Continue with Google** when they are shown.

> [!WARNING] Save the **recovery code** shown right after sign-up. It is shown once, and without a confirmed email it is the only way to reset a forgotten password.

## Your account name

Your public account name is made from the part of your email address before the `@`:

- It is lower-cased; anything other than letters, digits and `_` becomes `_`.
- A name that does not start with a letter gets `user_` in front; a name shorter than 3 characters gets `_user` after it. Names are at most 32 characters.
- If the name is taken, a digit is added (`ada2` up to `ada9`), then a short random suffix (`ada_3f9c`).

So `ada.lovelace@example.com` becomes `ada_lovelace`. An account created with GitHub or Google takes its name from the provider's login in the same way. Accounts and organizations share one namespace.

## Sign in

Sign in at [yonedarepo.com/signin](/signin) with your account name **or** your email address and your password, or with a linked GitHub or Google account.

- A browser session lasts 7 days.
- An account holds at most 10 sessions; signing in once more ends the oldest one.
- Sign-in attempts are limited to 10 a minute per account.

## Confirm your email address

After sign-up you get an email with a confirmation link. Open it and press the button on the page to confirm (opening the link alone does not). The link works once, for 24 hours. You can sign in before confirming; an unconfirmed address only receives the welcome and confirmation emails. **Settings → Email** shows the address and resends the link.

## Reset a forgotten password

1. On the sign-in page choose **Forgot password?** and enter your account name or email address.
2. Open the link in the email and choose a new password of 12 to 128 characters. The link works once, for 1 hour.
3. Save the **new** recovery code it shows. The old one no longer works.

The email goes only to a confirmed address, up to five times a day. A new request replaces the last link.

A reset ends every browser session and revokes every personal access token and CLI sign-in, with any SSH key a token added, so whoever had your account loses that access. Create new tokens and run `yoneda login` again afterwards. SSH keys you added yourself and linked GitHub or Google accounts stay: check them in **Settings**, or use your recovery code, which removes those too.

## Recover an account with the recovery code

Use this if your account has no confirmed email, or you no longer have the mailbox.

1. On the sign-in page choose **Use recovery code**.
2. Enter your account name or email address, the recovery code and a new password.
3. Save the **new** recovery code it shows. The old one no longer works.

> [!WARNING] Recovery signs you out everywhere: it ends every browser session and CLI sign-in, revokes every personal access token, removes every SSH key and unlinks GitHub and Google. Create new tokens and add your keys again afterwards.

## Settings

| Section | What it holds |
|---|---|
| Account | Your account name |
| Email | Your address and its confirmation |
| Connected accounts | Connect or disconnect GitHub and Google |
| Recovery code | Make a new code, shown once; the old one stops working. It needs a browser session, not a token, and an account with a password |
| Signed-in CLIs | Each `yoneda login` you approved, labelled with its machine, and each [agent](/docs/guides/tokens#agents); signing one out revokes its token |
| Personal access tokens | Tokens for Git, the API and MCP; see [Tokens and access](/docs/guides/tokens) |
| SSH keys | Keys for Git over SSH; see [Git over HTTPS and SSH](/docs/guides/git-remotes) |
| Billing | Credit and usage of the review agents; see [Credit and usage](/docs/agents/review-credit) |
