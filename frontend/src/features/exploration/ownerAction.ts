/**
 * Sends one owner mutation, then runs its optional follow-up with the response.
 * The request is unconditional: an optional call such as `then?.(await send())` would skip
 * evaluating its argument, and so the request, whenever no follow-up is given.
 */
export async function sendOwnerAction<T>(
  send: () => Promise<T>,
  then?: (value: T) => Promise<unknown>,
): Promise<T> {
  const value = await send();
  if (then) await then(value);
  return value;
}

/** A visible message for anything an owner action throws, including non-Error values. */
export function actionErrorMessage(error: unknown, action = 'action'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return `The ${action.replaceAll('_', ' ')} failed. Refresh to check its latest status before trying again.`;
}
