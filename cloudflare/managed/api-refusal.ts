// Managed browser API refusals, kept separate from route dispatch.
export class ApiRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
