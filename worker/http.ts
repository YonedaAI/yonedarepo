export const response = (value: unknown, status = 200) => Response.json(value, { status });
export const error = (code: string, message: string, status = 400) =>
  response({ error: { code, message } }, status);
export const now = () => Date.now();
export const safeId = (s: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(s);
