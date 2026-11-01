import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiToken, main, type Terminal, usage } from '../src/cli';
import { SelectorError } from '../src/selectors';
import { credentials, id, overview, token43 } from './fixtures';

const env = { KCP_HOME: '/nonexistent/kcp-test-home', KINGDOM_URL: 'http://localhost:4100' };
const token = `test_user_${'c'.repeat(48)}`;

/** A terminal that answers from the test: stdin's text, a prompt's answer, whether it is a person. */
const io = (options: Partial<Terminal> & { asked?: string[] } = {}): Terminal => ({
  readStdin: options.readStdin ?? (async () => ''),
  ask:
    options.ask ??
    (async (question) => {
      options.asked?.push(question);
      return null;
    }),
  interactive: options.interactive ?? false,
});

let enrolled: string[] = [];
let kingdom: ReturnType<typeof Bun.serve>;
let url = '';
beforeAll(() => {
  kingdom = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.headers.get('authorization') === `Bearer ${token}`) {
        if (path === '/api/v1/me/overview') return Response.json({ data: overview() });
        if (path === '/api/v1/access/enrollSignet') {
          enrolled.push(((await request.json()) as { signetId: string }).signetId);
          return Response.json({ data: credentials() });
        }
      }
      if (path === '/api/v1/access/nonce') return Response.json({ data: { nonce: token43('n') } });
      if (path === '/api/v1/access/installationInquiries')
        return Response.json({ message: 'down' }, { status: 503 });
      return new Response('refused', { status: 401 });
    },
  });
  url = `http://127.0.0.1:${kingdom.port}`;
});
afterAll(() => kingdom.stop(true));

const homes: string[] = [];
const quiet = () => [spyOn(console, 'log'), spyOn(console, 'error')];
let spies: ReturnType<typeof quiet> = [];
afterEach(async () => {
  enrolled = [];
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const kcpEnv = async (extra: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'kcp-cli-'));
  homes.push(home);
  spies = quiet();
  return { KCP_HOME: home, ...extra };
};

describe('kcp', () => {
  test('help prints usage, without git or --token among the selectors', async () => {
    spies = quiet();
    expect(await main(['help'], env)).toBe(0);
    expect(usage).toContain('kcp [selectors] <railway|gh|vercel|infisical> <args…>');
    expect(usage).not.toContain('--token TOKEN_ID');
  });
  test('a CLI KCP does not proxy is refused before any call', async () => {
    await expect(main(['ssh', 'host'], env)).rejects.toThrow(SelectorError);
  });
  test('git is refused: it is the local credential-helper path', async () => {
    await expect(main(['git', 'push'], env)).rejects.toThrow(/credential helper/);
  });
  test('map needs an API token: the overview is a user route', async () => {
    await expect(main(['map'], env)).rejects.toThrow(/Kingdom API token/);
  });
  test('unknown login flags are refused', async () => {
    await expect(main(['login', '--bogus'], env)).rejects.toThrow();
  });
});

describe('--token', () => {
  test('reads stdin for -, KINGDOM_TOKEN for env, and refuses the token itself', async () => {
    const stdin = io({ readStdin: async () => `  ${token}\n` });
    expect(await apiToken('-', {}, stdin)).toBe(token);
    expect(await apiToken('env', { KINGDOM_TOKEN: token }, stdin)).toBe(token);
    await expect(apiToken(token, { KINGDOM_TOKEN: token }, stdin)).rejects.toThrow(
      /never the token itself/,
    );
    await expect(apiToken('env', {}, stdin)).rejects.toThrow(/KINGDOM_TOKEN is empty/);
    await expect(apiToken('-', {}, io())).rejects.toThrow(/No token on stdin/);
  });
  test('KINGDOM_TOKEN is read only when --token asks for it', async () => {
    expect(await apiToken(undefined, { KINGDOM_TOKEN: token }, io())).toBeUndefined();
    await expect(main(['map'], { ...env, KINGDOM_TOKEN: token }, io())).rejects.toThrow(
      /--token - or --token env/,
    );
  });
  test('a literal token on the command line is refused before any call', async () => {
    const home = await kcpEnv();
    await expect(
      main(['login', '--token', token, '--url', url, '--yes'], home, io()),
    ).rejects.toThrow(/never the token itself/);
    expect(enrolled).toEqual([]);
  });
  test('login --token env --yes enrolls the Signets on families KCP serves', async () => {
    const home = await kcpEnv({ KINGDOM_TOKEN: token });
    expect(await main(['login', '--token', 'env', '--yes', '--url', url], home, io())).toBe(0);
    expect(enrolled).toEqual([id(11), id(14)]);
  });
  test('login --token - without --yes refuses when nothing can ask: stdin held the token', async () => {
    const home = await kcpEnv();
    const asked: string[] = [];
    const terminal = io({ readStdin: async () => token, interactive: true, asked });
    await expect(main(['login', '--token', '-', '--url', url], home, terminal)).rejects.toThrow(
      /Nothing enrolled/,
    );
    expect(asked).toEqual([]);
    expect(enrolled).toEqual([]);
  });
  test('login --token env asks a person, and enrolls only on yes', async () => {
    const home = await kcpEnv({ KINGDOM_TOKEN: token });
    const asked: string[] = [];
    await expect(
      main(['login', '--token', 'env', '--url', url], home, io({ interactive: true, asked })),
    ).rejects.toThrow(/Nothing enrolled/);
    expect(asked).toEqual(['Enroll these 2? [y/N] ']);
    expect(
      await main(
        ['login', '--token', 'env', '--url', url],
        home,
        io({ interactive: true, ask: async () => 'y' }),
      ),
    ).toBe(0);
    expect(enrolled).toEqual([id(11), id(14)]);
  });
  test('login --token - --signet enrolls just that one', async () => {
    const home = await kcpEnv();
    const terminal = io({ readStdin: async () => token });
    expect(
      await main(['login', '--token', '-', '--signet', id(15), '--url', url], home, terminal),
    ).toBe(0);
    expect(enrolled).toEqual([id(15)]);
  });
});

describe('logout', () => {
  test('a withdrawal Kingdom refused fails the command and says what to do in Kingdom', async () => {
    const home = await kcpEnv({ KINGDOM_TOKEN: token });
    await main(['login', '--token', 'env', '--signet', id(11), '--url', url], home, io());
    const errors = spies[1];
    expect(await main(['logout', '--url', url], home, io())).toBe(1);
    const said = errors?.mock.calls.map((call) => String(call[0])).join('\n') ?? '';
    expect(said).toContain('decline it in Kingdom');
    expect(said).toContain(`Revoke in Kingdom: Signet ${id(11)}`);
  });
});
