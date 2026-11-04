/** The exact plain Overview URL eligible for speculative code/admission startup. */
export function plainNamedOverview(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  reservedRoots: readonly string[],
) {
  const match = /^\/([a-z][a-z0-9_]{2,31})\/((?!\.)[A-Za-z0-9._-]{1,100})\/?$/.exec(
    location.pathname,
  );
  if (!match || reservedRoots.includes(match[1]) || location.search || location.hash) return;
  return { owner: match[1], name: match[2] };
}
