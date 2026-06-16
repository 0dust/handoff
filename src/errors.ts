export type RelayErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'INVALID_RECIPIENT'
  | 'INVALID_STATE_TRANSITION'
  | 'NOT_FOUND'
  | 'PACKET_TOO_LARGE'
  | 'REDACTION_BLOCKED'
  | 'SERVER_UNAVAILABLE'
  | 'TOKEN_REVOKED'
  | 'UNSUPPORTED_CLIENT';

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: RelayErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function relayError(
  code: RelayErrorCode,
  message: string,
  statusCode = 400,
  details?: unknown,
): RelayError {
  return new RelayError(code, message, statusCode, details);
}

export function isRelayError(error: unknown): error is RelayError {
  return error instanceof RelayError;
}
