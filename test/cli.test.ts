import { describe, expect, test } from 'bun:test';
import { main, usage } from '../src/cli';
import { SelectorError } from '../src/selectors';

const env = { KCP_HOME: '/nonexistent/kcp-test-home', KINGDOM_URL: 'http://localhost:4100' };

describe('kcp', () => {
  test('help prints usage', async () => {
    expect(await main(['help'], env)).toBe(0);
    expect(usage).toContain('kcp [selectors] <railway|gh|git|vercel|infisical> <args…>');
  });
  test('a CLI KCP does not proxy is refused before any call', async () => {
    await expect(main(['ssh', 'host'], env)).rejects.toThrow(SelectorError);
  });
  test('map needs an API token: the overview is a user route', async () => {
    await expect(main(['map'], env)).rejects.toThrow(/Kingdom API token/);
  });
  test('unknown login flags are refused', async () => {
    await expect(main(['login', '--bogus'], env)).rejects.toThrow();
  });
});
