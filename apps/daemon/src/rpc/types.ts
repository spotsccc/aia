export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
  readonly id?: JsonRpcId;
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface ClientHelloParams {
  readonly role: 'tui' | 'admin' | 'cli';
  readonly clientVersion?: string;
}

export interface ClientHelloResult {
  readonly name: 'aiad';
  readonly version: string;
  readonly protocolVersion: 1;
  readonly pid: number;
  readonly capabilities: {
    readonly serverNotifications: true;
    readonly sessions: false;
  };
}
