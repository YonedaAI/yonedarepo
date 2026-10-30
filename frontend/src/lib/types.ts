/** The signed-in account, as `GET /api/auth/session` reports it, with its picture's URL (null
 * for none: initials) and where the picture comes from. */
export type AccountIdentity = {
  username: string;
  /** The account's handle (`/<handle>`); null while an email-named account has none. Absent
   * from a server without handles. */
  handle?: string | null;
  /** A free handle made from the account's GitHub login, offered while it has none. */
  handle_suggestion?: string | null;
  avatar_url?: string | null;
  avatar_source?: 'upload' | 'provider' | null;
};
