import {
  internalErrorResponse,
  invalidParamsError,
  invalidRequestResponse,
  JsonRpcError,
  methodNotFoundResponse,
  parseErrorResponse,
} from "./errors.js";
import type {
  ClientHelloParams,
  ClientHelloResult,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

interface JsonRpcDispatcherOptions {
  readonly version?: string;
}

interface ValidatedRequest {
  readonly request: JsonRpcRequest;
  readonly hasId: boolean;
  readonly id: JsonRpcId;
}

export class JsonRpcDispatcher {
  private readonly version: string;

  public constructor(options: JsonRpcDispatcherOptions = {}) {
    this.version = options.version ?? "0.0.1";
  }

  public dispatchFrame(frame: Buffer): JsonRpcResponse | undefined {
    let message: unknown;

    try {
      message = JSON.parse(frame.toString("utf8"));
    } catch {
      return parseErrorResponse();
    }

    return this.dispatchMessage(message);
  }

  public dispatchMessage(message: unknown): JsonRpcResponse | undefined {
    const validated = validateRequest(message);
    if (validated === undefined) {
      return invalidRequestResponse(extractResponseId(message));
    }

    const { request, hasId, id } = validated;

    if (request.method !== "client/hello") {
      return hasId ? methodNotFoundResponse(id) : undefined;
    }

    try {
      const result = this.handleHello(request.params);
      return hasId
        ? {
            jsonrpc: "2.0",
            id,
            result,
          }
        : undefined;
    } catch (error) {
      if (!hasId) {
        return undefined;
      }

      if (error instanceof JsonRpcError) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: error.code,
            message: error.message,
            ...(error.data === undefined ? {} : { data: error.data }),
          },
        };
      }

      return internalErrorResponse(id);
    }
  }

  private handleHello(params: unknown): ClientHelloResult {
    parseHelloParams(params);

    return {
      name: "aiad",
      version: this.version,
      protocolVersion: 1,
      pid: process.pid,
      capabilities: {
        serverNotifications: true,
        sessions: false,
      },
    };
  }
}

function validateRequest(message: unknown): ValidatedRequest | undefined {
  if (!isRecord(message) || Array.isArray(message)) {
    return undefined;
  }

  if (message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") {
    return undefined;
  }

  const hasId = Object.hasOwn(message, "id");
  let id: JsonRpcId = null;
  if (hasId) {
    const rawId = message["id"];
    if (!isJsonRpcId(rawId)) {
      return undefined;
    }
    id = rawId;
  }

  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: message["method"],
    ...(Object.hasOwn(message, "params") ? { params: message["params"] } : {}),
    ...(hasId ? { id } : {}),
  };

  return {
    request,
    hasId,
    id,
  };
}

function extractResponseId(message: unknown): JsonRpcId {
  if (!isRecord(message) || Array.isArray(message)) {
    return null;
  }

  const id = message["id"];
  return isJsonRpcId(id) ? id : null;
}

function parseHelloParams(params: unknown): ClientHelloParams {
  if (!isRecord(params) || Array.isArray(params)) {
    throw invalidParamsError();
  }

  const role = params["role"];
  if (role !== "tui" && role !== "admin" && role !== "cli") {
    throw invalidParamsError();
  }

  const clientVersion = params["clientVersion"];
  if (clientVersion !== undefined && typeof clientVersion !== "string") {
    throw invalidParamsError();
  }

  return clientVersion === undefined ? { role } : { role, clientVersion };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || isFiniteNumber(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
