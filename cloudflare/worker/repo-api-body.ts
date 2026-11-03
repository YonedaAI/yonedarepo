// REST body decoding keeps the same validation and limits across entrypoints and routes.
import { readJson } from './http';
import { ApiError } from './repo-ops';
export const COMMIT_BODY_LIMIT = 64 * 1024 * 1024;
export const bodyOf = (req: Request, limit?: number) =>
  readJson(req, limit).catch((e) => {
    throw new ApiError('INVALID_INPUT', String(e?.message ?? e));
  });
