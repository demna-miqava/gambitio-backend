/**
 * An error with an HTTP status and machine-readable code. The global error
 * handler sends these to the client as-is; anything else becomes a 500.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}
