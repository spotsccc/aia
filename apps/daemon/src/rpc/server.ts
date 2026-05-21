import { chmod, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsonRpcDispatcher } from './dispatcher.js';
import { parseErrorResponse } from './errors.js';
import { encodeRpcFrame, RpcFrameParser } from './framing.js';

const SOCKET_FILE_NAME = 'daemon.sock';
const PID_FILE_NAME = 'aiad.pid';

export interface RpcServerOptions {
  readonly runtimeDir?: string;
  readonly socketPath?: string;
  readonly pidFilePath?: string;
  readonly version?: string;
}

export interface RpcRuntimePaths {
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly pidFilePath: string;
}

export interface RpcServerHandle {
  readonly socketPath: string;
  readonly pidFilePath: string;
  readonly server: Server;
  stop(): Promise<void>;
}

export class RpcServerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RpcServerError';
  }
}

export class RpcServerAlreadyRunningError extends RpcServerError {
  public constructor(public readonly pid: string | undefined) {
    super(`aiad already running, pid=${pid ?? 'unknown'}`);
    this.name = 'RpcServerAlreadyRunningError';
  }
}

export class RpcConnection {
  private readonly parser = new RpcFrameParser();

  public constructor(
    private readonly socket: Socket,
    private readonly dispatcher: JsonRpcDispatcher,
  ) {
    this.socket.on('data', (chunk: Buffer) => {
      this.handleData(chunk);
    });
    this.socket.on('error', () => undefined);
  }

  public notify(method: string, params?: unknown): void {
    const message =
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    this.write(message);
  }

  public destroy(): void {
    this.socket.destroy();
  }

  private handleData(chunk: Buffer): void {
    let frames: Buffer[];

    try {
      frames = this.parser.push(chunk);
    } catch {
      this.write(parseErrorResponse());
      this.socket.destroy();
      return;
    }

    for (const frame of frames) {
      const response = this.dispatcher.dispatchFrame(frame);
      if (response !== undefined) {
        this.write(response);
      }
    }
  }

  private write(message: unknown): void {
    this.socket.write(encodeRpcFrame(message));
  }
}

interface ManagedRpcServer {
  readonly server: Server;
  destroyConnections(): void;
}

export function defaultRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtimeDir = env['XDG_RUNTIME_DIR'];
  return runtimeDir === undefined || runtimeDir.length === 0
    ? join(homedir(), '.local', 'state', 'aia')
    : runtimeDir;
}

export function resolveRpcRuntimePaths(options: RpcServerOptions = {}): RpcRuntimePaths {
  const runtimeDir =
    options.runtimeDir ??
    (options.socketPath === undefined ? defaultRuntimeDir() : dirname(options.socketPath));
  const socketPath = options.socketPath ?? join(runtimeDir, SOCKET_FILE_NAME);
  const pidFilePath = options.pidFilePath ?? join(dirname(socketPath), PID_FILE_NAME);

  return {
    runtimeDir,
    socketPath,
    pidFilePath,
  };
}

export async function startRpcServer(options: RpcServerOptions = {}): Promise<RpcServerHandle> {
  const paths = resolveRpcRuntimePaths(options);
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await ensureSocketAvailable(paths.socketPath, paths.pidFilePath);

  const managedServer = createManagedRpcServer(options.version);
  let listening = false;

  try {
    await listen(managedServer.server, paths.socketPath);
    listening = true;
    await chmod(paths.socketPath, 0o600);
    await writePidFile(paths.pidFilePath, process.pid);
  } catch (error) {
    managedServer.destroyConnections();
    if (listening) {
      await closeServer(managedServer.server);
      await unlinkIfExists(paths.socketPath);
    }
    throw error;
  }

  let stopped = false;

  return {
    socketPath: paths.socketPath,
    pidFilePath: paths.pidFilePath,
    server: managedServer.server,
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }

      stopped = true;
      managedServer.destroyConnections();
      await closeServer(managedServer.server);
      await cleanupOwnedRuntimeFiles(paths);
    },
  };
}

export function installRpcServerSignalHandlers(handle: RpcServerHandle): void {
  const shutdown = (): void => {
    void handle.stop().finally(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function createManagedRpcServer(version: string | undefined): ManagedRpcServer {
  const dispatcher = new JsonRpcDispatcher({ version });
  const connections = new Set<RpcConnection>();
  const server = createServer((socket) => {
    const connection = new RpcConnection(socket, dispatcher);
    connections.add(connection);
    socket.on('close', () => {
      connections.delete(connection);
    });
  });

  return {
    server,
    destroyConnections(): void {
      for (const connection of connections) {
        connection.destroy();
      }
      connections.clear();
    },
  };
}

async function ensureSocketAvailable(socketPath: string, pidFilePath: string): Promise<void> {
  let socketStat;

  try {
    socketStat = await stat(socketPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }

    throw new RpcServerError(`cannot inspect socket path ${socketPath}: ${errorMessage(error)}`);
  }

  if (!socketStat.isSocket()) {
    throw new RpcServerError(`socket path is occupied by a non-socket file: ${socketPath}`);
  }

  if (await canConnect(socketPath)) {
    throw new RpcServerAlreadyRunningError(await readPid(pidFilePath));
  }

  try {
    await unlink(socketPath);
  } catch (error) {
    throw new RpcServerError(`cannot remove stale socket ${socketPath}: ${errorMessage(error)}`);
  }
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      resolve(false);
    }, 250);

    function cleanup(): void {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    }

    function onConnect(): void {
      cleanup();
      socket.destroy();
      resolve(true);
    }

    function onError(): void {
      cleanup();
      socket.destroy();
      resolve(false);
    }

    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    function onError(error: Error): void {
      server.off('listening', onListening);
      reject(error);
    }

    function onListening(): void {
      server.off('error', onError);
      resolve();
    }

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      if (isNodeError(error) && error.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

async function writePidFile(pidFilePath: string, pid: number): Promise<void> {
  const file = await open(pidFilePath, 'w', 0o600);
  try {
    await file.writeFile(`${pid}\n`, 'utf8');
  } finally {
    await file.close();
  }

  await chmod(pidFilePath, 0o600);
}

async function cleanupOwnedRuntimeFiles(paths: RpcRuntimePaths): Promise<void> {
  const pid = await readPid(paths.pidFilePath);
  if (pid !== String(process.pid)) {
    return;
  }

  await Promise.all([unlinkIfExists(paths.socketPath), unlinkIfExists(paths.pidFilePath)]);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

async function readPid(pidFilePath: string): Promise<string | undefined> {
  try {
    const pid = (await readFile(pidFilePath, 'utf8')).trim();
    return /^\d+$/.test(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
