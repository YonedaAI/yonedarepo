// Expected repository refusals cross an RPC boundary as data. Remote runtimes need not
// preserve custom fields on thrown Error objects, including the API's status code.
import { rpcValue } from './durable';
import { ApiError, type Json } from './repo-ops';

/** The holder's successful value or a serializable domain refusal; faults still throw. */
export async function repoRpcAnswer(call: Promise<Json>): Promise<Json> {
  try {
    return await call;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return {
      error: { code: e.code, message: e.message, ...(e.details && { details: e.details }) },
    };
  }
}

/** Disposes an RPC result and restores a domain refusal before a caller caches its value. */
export async function repoRpcValue(call: Promise<Json>): Promise<Json> {
  const value = await rpcValue(call);
  if (value.error) throw new ApiError(value.error.code, value.error.message, value.error.details);
  return value;
}
