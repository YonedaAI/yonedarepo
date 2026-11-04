/** A telemetry source could not be read; `reason` is safe to store and show. */
export class TelemetryError extends Error {
  constructor(
    readonly reason: 'config' | 'disabled' | 'token_missing' | 'fetch_failed' | 'tail_silent',
    detail: string,
  ) {
    super(detail);
  }
}
