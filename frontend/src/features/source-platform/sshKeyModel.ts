// SSH public keys for Git over SSH (`/api/v1/ssh-keys`). The platform parses and
// fingerprints a key and decides; this only catches the usual paste mistakes early.

export type SshKey = {
  id: string;
  title: string;
  fingerprint: string;
  algorithm: string;
  created_at: number;
  last_used_at: number | null;
};

/** How clients reach Git over SSH (`ssh` beside the keys); `host` null while it is off. */
export type SshAccess = {
  front_door: 'tunnel' | 'connect' | null;
  host: string | null;
  clone_url: string | null;
  ssh_config: string | null;
};

const KEY_TYPE = /^(ssh-|ecdsa-|sk-)/;

/** Why a pasted public key would be refused before sending it, or '' when it looks right. */
export function publicKeyProblem(text: string): string {
  const pasted = text.trim();
  if (!pasted) return '';
  if (pasted.includes('PRIVATE KEY'))
    return 'That is a private key. Paste the contents of the .pub file instead, and keep the private key secret.';
  const lines = pasted.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length !== 1) return 'Paste exactly one public key (one line).';
  const [kind, body] = lines[0].trim().split(/\s+/);
  if (!body || !KEY_TYPE.test(kind))
    return 'Not an OpenSSH public key: expected a line like "ssh-ed25519 AAAA… you@host".';
  return '';
}

/** The title a key gets when none is typed: its comment, if it has one. */
export function suggestedTitle(text: string): string {
  const parts = text.trim().split(/\s+/);
  return parts.length > 2 ? parts.slice(2).join(' ').slice(0, 64) : '';
}
