import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSignetKey, readPrivateJson, writePrivateJson } from '@inixiative/signet';
import { SignetHolders } from '../src/holders';
import { installationPaths } from '../src/installation';
import { savedKingdomUrl } from '../src/kingdom';
import {
  loginWithSignet,
  loginWithToken,
  logout,
  pairKcp,
  status,
  supportedInstallationKind,
} from '../src/session';
import {
  credentials,
  description,
  holdSignet,
  id,
  orgOwner,
  overview,
  token43,
  tribe,
} from './fixtures';

const apiToken = `test_user_${'c'.repeat(48)}`;
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const home = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcp-home-'));
  homes.push(directory);
  return directory;
};

/** A loopback Kingdom answering the calls a token login makes. */
const calls: { path: string; authorization: string | null; dpop: boolean; body: unknown }[] = [];
let kingdom: ReturnType<typeof Bun.serve>;
let url = '';
beforeAll(() => {
  kingdom = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : null;
      calls.push({
        path,
        authorization: request.headers.get('authorization'),
        dpop: request.headers.has('dpop'),
        body,
      });
      if (path === '/api/v1/me/overview') return Response.json({ data: overview() });
      if (path === '/api/v1/access/nonce') return Response.json({ data: { nonce: token43('n') } });
      if (path === '/api/v1/access/enrollSignet') return Response.json({ data: credentials() });
      return new Response('not found', { status: 404 });
    },
  });
  url = `http://127.0.0.1:${kingdom.port}`;
});
afterAll(() => kingdom.stop(true));

describe('login', () => {
  test('browser pairing waits on the kcp installation kind', async () => {
    expect(supportedInstallationKind()).toBeNull();
    await expect(
      pairKcp({ home: await home(), url: 'http://localhost:4100', onReview: () => {} }),
    ).rejects.toThrow(/'kcp' installation kind/);
  });

  test('--token enrolls each Signet issued to the person, records its integration, and never stores the token', async () => {
    calls.length = 0;
    const kcpHome = await home();
    const result = await loginWithToken({ home: kcpHome, url, apiToken, name: 'KCP test' });
    expect(result).toEqual({ url, signetIds: [id(11)] });
    const enroll = calls.find((call) => call.path === '/api/v1/access/enrollSignet');
    expect(enroll).toMatchObject({
      authorization: `Bearer ${apiToken}`,
      dpop: true,
      body: { signetId: id(11), expectedRevision: 3, name: 'KCP test' },
    });
    const { directory } = installationPaths(kcpHome, url);
    const saved = await readPrivateJson(join(directory, `signet-${id(11)}.json`));
    expect(saved).toMatchObject({
      signetId: id(11),
      integrationId: id(1),
      owner: orgOwner(tribe),
      url,
    });
    expect(await savedKingdomUrl(kcpHome)).toBe(url);
    for (const name of await readdir(directory))
      expect(await readFile(join(directory, name), 'utf8')).not.toContain(apiToken);

    calls.length = 0;
    expect(await loginWithToken({ home: kcpHome, url, apiToken })).toEqual({ url, signetIds: [] });
    expect(calls.some((call) => call.path === '/api/v1/access/enrollSignet')).toBe(false);
  });

  test('--token --signet refuses a Signet not issued to the person', async () => {
    await expect(
      loginWithToken({ home: await home(), url, apiToken, signetId: id(13) }),
    ).rejects.toThrow(/isn't issued to you/);
  });

  test('--signet <file> copies a credential in, keeping its key where it is', async () => {
    const source = await home();
    const keyFile = join(source, 'key.json');
    await writePrivateJson(keyFile, generateSignetKey());
    const file = join(source, 'signet.json');
    await writePrivateJson(file, {
      ...credentials(),
      signetId: id(31),
      integrationId: id(1),
      url: 'http://localhost:4100',
      keyFile,
    });
    const kcpHome = await home();
    expect(
      await loginWithSignet({ home: kcpHome, url: 'http://localhost:4100', signet: file }),
    ).toEqual({
      url: 'http://localhost:4100',
      signetIds: [id(31)],
    });
    const copied = join(
      installationPaths(kcpHome, 'http://localhost:4100').directory,
      `signet-${id(31)}.json`,
    );
    expect(await readPrivateJson(copied)).toMatchObject({ signetId: id(31), keyFile });
  });

  test('--signet <id> without a pairing or a token says what it needs', async () => {
    await expect(
      loginWithSignet({ home: await home(), url: 'http://localhost:4100', signet: id(31) }),
    ).rejects.toThrow(/paired \(kcp login\) or --token/);
  });
});

describe('status and logout', () => {
  test('status describes each held Signet; logout deletes the key and Signets', async () => {
    const kcpHome = await home();
    const local = 'http://localhost:4100';
    await holdSignet(kcpHome, local, {
      signetId: id(11),
      integrationId: id(1),
      owner: orgOwner(tribe),
    });
    const holders = new SignetHolders({
      describe: async ({ signetId }) =>
        description({ signetId, integrationId: id(1), provider: 'railway', resourceId: id(21) }),
    });
    const current = await status(kcpHome, local, holders);
    expect(current).toMatchObject({
      url: local,
      loggedIn: true,
      installation: null,
      pairingSupported: false,
      signets: [
        {
          signetId: id(11),
          integrationId: id(1),
          provider: 'railway',
          owner: orgOwner(tribe),
          status: 'described',
        },
      ],
    });
    expect(await logout(kcpHome, local)).toEqual({
      url: local,
      removedSignetIds: [id(11)],
      withdrawnRegistrations: [],
    });
    expect(existsSync(installationPaths(kcpHome, local).directory)).toBe(false);
    expect((await status(kcpHome, local, holders)).loggedIn).toBe(false);
  });
});
