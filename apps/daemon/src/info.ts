export interface DaemonInfo {
  readonly name: string;
  readonly version: string;
}

export function daemonInfo(): DaemonInfo {
  return { name: 'aiad', version: '0.0.0' };
}
