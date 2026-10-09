/** Thrown when a mutation would fail on the server. Mirrors its status and message. */
export class MutationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MutationError";
    this.status = status;
  }
}
