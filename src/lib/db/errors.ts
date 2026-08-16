export class DatabaseContractError extends Error {
  constructor(
    message: string,
    readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "DATABASE_ERROR",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DatabaseContractError";
  }
}

export function databaseFailure(message: string, cause: unknown): never {
  throw new DatabaseContractError(message, "DATABASE_ERROR", cause);
}

