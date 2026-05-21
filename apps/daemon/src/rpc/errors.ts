import type { JsonRpcErrorResponse, JsonRpcId } from './types.js';

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export class JsonRpcError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export function jsonRpcErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const error: JsonRpcErrorResponse['error'] =
    data === undefined ? { code, message } : { code, message, data };

  return {
    jsonrpc: '2.0',
    id,
    error,
  };
}

export function parseErrorResponse(): JsonRpcErrorResponse {
  return jsonRpcErrorResponse(null, JsonRpcErrorCode.ParseError, 'Parse error');
}

export function invalidRequestResponse(id: JsonRpcId): JsonRpcErrorResponse {
  return jsonRpcErrorResponse(id, JsonRpcErrorCode.InvalidRequest, 'Invalid Request');
}

export function methodNotFoundResponse(id: JsonRpcId): JsonRpcErrorResponse {
  return jsonRpcErrorResponse(id, JsonRpcErrorCode.MethodNotFound, 'Method not found');
}

export function invalidParamsError(): JsonRpcError {
  return new JsonRpcError(JsonRpcErrorCode.InvalidParams, 'Invalid params');
}

export function internalErrorResponse(id: JsonRpcId): JsonRpcErrorResponse {
  return jsonRpcErrorResponse(id, JsonRpcErrorCode.InternalError, 'Internal error');
}
