// The api.md error envelope and its codes.
const STATUS = {
  validation_failed: 400,
  forbidden_origin: 403,
  not_found: 404,
  turn_busy: 409,
  conflict: 409,
  payload_too_large: 413,
  ingest_failed: 422,
  budget_exceeded: 429,
  upstream_error: 502,
  internal_error: 500,
} as const
export type ErrorCode = keyof typeof STATUS

export class ApiError extends Error {
  readonly status: number
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = STATUS[code]
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    }
  }
}

export const apiError = (code: ErrorCode, message: string, details?: unknown) =>
  new ApiError(code, message, details)
