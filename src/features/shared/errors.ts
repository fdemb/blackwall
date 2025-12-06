export class AppError extends Error {
  constructor(
    public readonly errorCode:
      | "BAD_REQUEST"
      | "NOT_FOUND"
      | "FORBIDDEN"
      | "CONFLICT"
      | "INTERNAL_SERVER_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
