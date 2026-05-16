import { describe, expect, it } from 'vitest';
import { daemonInfo } from './info.js';

describe('daemonInfo', () => {
  it('returns the daemon name and version', () => {
    const info = daemonInfo();
    expect(info.name).toBe('aiad');
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
