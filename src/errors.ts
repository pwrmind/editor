export const ErrorCode = {
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  WORKSPACE_VIOLATION: "WORKSPACE_VIOLATION",
  BINARY_FILE: "BINARY_FILE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  INVALID_ENCODING: "INVALID_ENCODING",
  SEARCH_NOT_FOUND: "SEARCH_NOT_FOUND",
  SEARCH_AMBIGUOUS: "SEARCH_AMBIGUOUS",
  STALE_CONTENT: "STALE_CONTENT",
  TRANSACTION_CONFLICT: "TRANSACTION_CONFLICT",
  NO_ACTIVE_TRANSACTION: "NO_ACTIVE_TRANSACTION",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export class StructuredError extends Error {
  constructor(
    public code: ErrorCode,
    public message: string,
    public hint: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "StructuredError";
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
    };
  }
}