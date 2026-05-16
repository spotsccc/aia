import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRpcErrorCode } from './errors.js';
import { encodeRpcFrame, RpcFrameParser } from './framing.js';
import { startRpcServer, type RpcServerHandle } from './server.js';

const handles: RpcServerHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('RPC Unix domain socket server', () => {
  it('creates runtime files with 0600 permissions', async () => {
    const handle = await startTestServer();

    const socketStat = await stat(handle.socketPath);
    const pidFileStat = await stat(handle.pidFilePath);

    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.mode & 0o777).toBe(0o600);
    expect(pidFileStat.isFile()).toBe(true);
    expect(pidFileStat.mode & 0o777).toBe(0o600);
    expect((await readFile(handle.pidFilePath, 'utf8')).trim()).toBe(String(process.pid));
  });

  it('returns the expected client/hello result', async () => {
    const handle = await startTestServer();

    const response = await sendMessage(handle.socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'client/hello',
      params: { role: 'cli', clientVersion: 'test' },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        name: 'aiad',
        version: '9.8.7',
        protocolVersion: 1,
        pid: process.pid,
        capabilities: {
          serverNotifications: true,
          sessions: false,
        },
      },
    });
  });

  it('returns invalid params for malformed client/hello params', async () => {
    const handle = await startTestServer();

    const response = await sendMessage(handle.socketPath, {
      jsonrpc: '2.0',
      id: 'bad-params',
      method: 'client/hello',
      params: { role: 'browser' },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'bad-params',
      error: { code: JsonRpcErrorCode.InvalidParams, message: 'Invalid params' },
    });
  });

  it('returns method not found for unknown methods', async () => {
    const handle = await startTestServer();

    const response = await sendMessage(handle.socketPath, {
      jsonrpc: '2.0',
      id: 404,
      method: 'unknown/method',
      params: {},
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 404,
      error: { code: JsonRpcErrorCode.MethodNotFound, message: 'Method not found' },
    });
  });

  it('does not respond to notifications without an id', async () => {
    const handle = await startTestServer();

    const response = await sendMessage(
      handle.socketPath,
      {
        jsonrpc: '2.0',
        method: 'client/hello',
        params: { role: 'admin' },
      },
      100,
    );

    expect(response).toBeUndefined();
  });

  it('rejects a second server on the same socket as already running', async () => {
    const runtimeDir = await createTempRuntimeDir();
    const handle = await startRpcServer({ runtimeDir, version: '9.8.7' });
    handles.push(handle);

    await expect(startRpcServer({ runtimeDir, version: '9.8.7' })).rejects.toThrow(
      /aiad already running, pid=\d+/,
    );
  });
});

async function startTestServer(): Promise<RpcServerHandle> {
  const runtimeDir = await createTempRuntimeDir();
  const handle = await startRpcServer({ runtimeDir, version: '9.8.7' });
  handles.push(handle);
  return handle;
}

async function createTempRuntimeDir(): Promise<string> {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'aia-daemon-'));
  tempDirs.push(runtimeDir);
  return runtimeDir;
}

function sendMessage(
  socketPath: string,
  message: unknown,
  timeoutMs = 1_000,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const parser = new RpcFrameParser();
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      resolve(undefined);
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('data', onData);
      socket.off('error', onError);
    }

    function onConnect(): void {
      socket.write(encodeRpcFrame(message));
    }

    function onData(chunk: Buffer): void {
      let frames: Buffer[];

      try {
        frames = parser.push(chunk);
      } catch (error) {
        cleanup();
        socket.destroy();
        reject(error);
        return;
      }

      const frame = frames[0];
      if (frame === undefined) {
        return;
      }

      cleanup();
      socket.end();
      resolve(JSON.parse(frame.toString('utf8')) as Record<string, unknown>);
    }

    function onError(error: Error): void {
      cleanup();
      socket.destroy();
      reject(error);
    }

    socket.once('connect', onConnect);
    socket.on('data', onData);
    socket.once('error', onError);
  });
}
