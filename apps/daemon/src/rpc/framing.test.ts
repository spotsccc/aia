import { describe, expect, it } from 'vitest';
import { encodeRpcFrame, RpcFrameParser } from './framing.js';

describe('RPC framing', () => {
  it('roundtrips encoded messages', () => {
    const message = {
      jsonrpc: '2.0',
      id: 1,
      method: 'client/hello',
      params: { role: 'cli' },
    };
    const parser = new RpcFrameParser();

    const frames = parser.push(encodeRpcFrame(message));

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]?.toString('utf8') ?? '')).toEqual(message);
  });

  it('handles a body split across chunks', () => {
    const message = {
      jsonrpc: '2.0',
      id: 'split',
      method: 'client/hello',
      params: { role: 'tui' },
    };
    const encoded = encodeRpcFrame(message);
    const bodyStart = encoded.indexOf('\r\n\r\n') + 4;
    const parser = new RpcFrameParser();

    expect(parser.push(encoded.subarray(0, bodyStart + 3))).toEqual([]);
    const frames = parser.push(encoded.subarray(bodyStart + 3));

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]?.toString('utf8') ?? '')).toEqual(message);
  });

  it('handles multiple frames in one chunk', () => {
    const first = { jsonrpc: '2.0', id: 1, method: 'client/hello', params: { role: 'cli' } };
    const second = { jsonrpc: '2.0', id: 2, method: 'client/hello', params: { role: 'admin' } };
    const parser = new RpcFrameParser();

    const frames = parser.push(Buffer.concat([encodeRpcFrame(first), encodeRpcFrame(second)]));

    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[0]?.toString('utf8') ?? '')).toEqual(first);
    expect(JSON.parse(frames[1]?.toString('utf8') ?? '')).toEqual(second);
  });

  it('uses UTF-8 byte lengths for Unicode bodies', () => {
    const message = {
      jsonrpc: '2.0',
      id: 'unicode',
      method: 'client/hello',
      params: { role: 'cli', clientVersion: 'клиент-1' },
    };
    const encoded = encodeRpcFrame(message);
    const bodyStart = encoded.indexOf('\r\n\r\n') + 4;
    const header = encoded.subarray(0, bodyStart).toString('ascii');
    const body = encoded.subarray(bodyStart);
    const parser = new RpcFrameParser();

    expect(header).toBe(`Content-Length: ${body.byteLength}\r\n\r\n`);
    const frames = parser.push(encoded);

    expect(JSON.parse(frames[0]?.toString('utf8') ?? '')).toEqual(message);
  });
});
