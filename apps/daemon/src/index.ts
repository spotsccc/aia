#!/usr/bin/env node
import { installRpcServerSignalHandlers, startRpcServer } from './rpc/server.js';

async function main(): Promise<void> {
  const handle = await startRpcServer();
  installRpcServerSignalHandlers(handle);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
