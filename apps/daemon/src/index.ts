#!/usr/bin/env node
import { daemonInfo } from './info.js';

function main(): void {
  const info = daemonInfo();
  console.log(`${info.name} v${info.version} — not yet implemented`);
}

main();
