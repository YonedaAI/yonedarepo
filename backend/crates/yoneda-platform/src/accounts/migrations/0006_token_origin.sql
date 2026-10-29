-- How a personal token was made: origin 'login' for a `yoneda login` (device flow) token,
-- with the host its CLI reported (NULL when an older CLI sent none), and NULL for a token
-- made on the website. Tokens made before this named 'yoneda-cli' (the CLI's device client
-- name, which the browser already treated as a login) are marked as logins, host unknown.
ALTER TABLE account_tokens ADD COLUMN origin TEXT;
ALTER TABLE account_tokens ADD COLUMN host TEXT;
UPDATE account_tokens SET origin='login' WHERE name='yoneda-cli';
ALTER TABLE device_codes ADD COLUMN host TEXT;
-- Records of the retired agent layer (projects, providers and their credentials, grants,
-- budget reservations, spend) are inert: nothing reads them since the account authority
-- moved into yoneda-platform. Only the account, sign-in sessions, the login rate, the team
-- counter and a retained reviewer policy are read.
DELETE FROM workspace_records
  WHERE id NOT IN ('account','login_rate','team_seq','reviewer_policy') AND id NOT LIKE 'session:%'
