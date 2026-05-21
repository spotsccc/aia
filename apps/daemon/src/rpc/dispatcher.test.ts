import { describe, expect, it } from 'vitest';
import { JsonRpcDispatcher } from './dispatcher.js';
import { JsonRpcErrorCode } from './errors.js';

describe('JSON-RPC dispatcher', () => {
  it('returns a parse error for malformed JSON frames', () => {
    const dispatcher = new JsonRpcDispatcher({ version: '1.2.3' });

    const response = dispatcher.dispatchFrame(Buffer.from('{"jsonrpc":"2.0",', 'utf8'));

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: JsonRpcErrorCode.ParseError, message: 'Parse error' },
    });
  });

  it('rejects top-level arrays as invalid requests', () => {
    const dispatcher = new JsonRpcDispatcher({ version: '1.2.3' });

    const response = dispatcher.dispatchMessage([]);

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: JsonRpcErrorCode.InvalidRequest, message: 'Invalid Request' },
    });
  });
});
