/**
 * ApiError — an error that knows its HTTP status. Services throw these so the
 * server can answer with a meaningful 4xx instead of a generic 500; the message
 * is always safe to show the caller (fail loud, explain clearly).
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
