export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'AppError'
  }
}
