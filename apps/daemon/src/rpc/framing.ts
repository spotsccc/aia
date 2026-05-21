const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');

export class RpcFramingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RpcFramingError';
  }
}

export class RpcFrameParser {
  private buffer = Buffer.alloc(0);

  public push(chunk: Buffer): Buffer[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    this.buffer =
      this.buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);

    const frames: Buffer[] = [];

    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) {
        break;
      }

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const contentLength = readContentLength(header);
      const bodyStart = headerEnd + HEADER_SEPARATOR.byteLength;
      const frameEnd = bodyStart + contentLength;

      if (this.buffer.byteLength < frameEnd) {
        break;
      }

      frames.push(Buffer.from(this.buffer.subarray(bodyStart, frameEnd)));
      this.buffer = this.buffer.subarray(frameEnd);
    }

    return frames;
  }
}

export function encodeRpcFrame(message: unknown): Buffer {
  const json = JSON.stringify(message);
  if (json === undefined) {
    throw new TypeError('JSON-RPC frame body must be JSON-serializable');
  }

  return encodeRpcBody(Buffer.from(json, 'utf8'));
}

export function encodeRpcBody(body: Buffer): Buffer {
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

function readContentLength(header: string): number {
  let contentLength: number | undefined;

  for (const line of header.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const name = line.slice(0, separator).trim().toLowerCase();
    if (name !== 'content-length') {
      continue;
    }

    const rawValue = line.slice(separator + 1).trim();
    if (!/^(?:0|[1-9]\d*)$/.test(rawValue)) {
      throw new RpcFramingError('Invalid Content-Length header');
    }

    const parsed = Number(rawValue);
    if (!Number.isSafeInteger(parsed)) {
      throw new RpcFramingError('Content-Length header is too large');
    }

    contentLength = parsed;
  }

  if (contentLength === undefined) {
    throw new RpcFramingError('Missing Content-Length header');
  }

  return contentLength;
}
