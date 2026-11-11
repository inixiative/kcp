import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSignetKey,
  installationPaths,
  readPrivateJson,
  SignetHolders,
  writePrivateJson,
} from '@inixiative/signet';
import { savedKingdomUrl } from '../src/kingdom';
import {
  type EnrollCandidate,
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
  grantRow,
  holdSignet,
  id,
  orgOwner,
  overview,
  token43,
  tribe,
  viewer,
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

/** What the loopback Kingdom answers for `/me/overview` and `installationInquiries`. */
let currentOverview: ReturnType<typeof overview> = overview();
let inquiriesStatus = 200;
afterEach(() => {
  currentOverview = overview();
  inquiriesStatus = 200;
});
const enrolls = () => calls.filter((call) => call.path === '/api/v1/access/enrollSignet');

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
      if (path === '/api/v1/me/overview') return Response.json({ data: currentOverview });
      if (path === '/api/v1/access/nonce') return Response.json({ data: { nonce: token43('n') } });
      if (path === '/api/v1/access/enrollSignet') {
        // Slow enough that two unlocked logins would both enroll.
        await Bun.sleep(30);
        return Response.json({ data: credentials() });
      }
      if (path === '/api/v1/access/installationInquiries')
        return inquiriesStatus === 200
          ? Response.json({
              data: { pending: null, declinedAt: null, inquiries: [], hostedSignetRequests: [] },
            })
          : Response.json({ message: 'Kingdom is down' }, { status: inquiriesStatus });
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

  test('--token lists the Signets on families KCP serves, enrolls them once confirmed, and never stores the token', async () => {
    calls.length = 0;
    const kcpHome = await home();
    const offered: EnrollCandidate[][] = [];
    const confirm = async (candidates: readonly EnrollCandidate[]) => {
      offered.push([...candidates]);
      return true;
    };
    const result = await loginWithToken({
      home: kcpHome,
      url,
      apiToken,
      name: 'KCP test',
      confirm,
    });
    expect(offered).toEqual([
      [
        {
          signetId: id(11),
          name: 'Railway for Aron',
          integrations: [{ integrationId: id(1), family: 'railway' }],
        },
        {
          signetId: id(14),
          name: 'GitHub for Aron',
          integrations: [{ integrationId: id(3), family: 'github' }],
        },
      ],
    ]);
    expect(result).toEqual({ url, signetIds: [id(11), id(14)] });
    expect(enrolls()[0]).toMatchObject({
      authorization: `Bearer ${apiToken}`,
      dpop: true,
      body: { signetId: id(11), expectedRevision: 3, name: 'KCP test' },
    });
    const { directory } = installationPaths(kcpHome, url);
    expect(await readPrivateJson(join(directory, `signet-${id(11)}.json`))).toMatchObject({
      signetId: id(11),
      owner: orgOwner(tribe),
      url,
    });
    expect(existsSync(join(directory, `signet-${id(15)}.json`))).toBe(false);
    expect(await savedKingdomUrl(kcpHome)).toBe(url);
    for (const name of await readdir(directory))
      expect(await readFile(join(directory, name), 'utf8')).not.toContain(apiToken);

    calls.length = 0;
    expect(await loginWithToken({ home: kcpHome, url, apiToken, confirm })).toEqual({
      url,
      signetIds: [],
    });
    expect(offered).toHaveLength(1);
    expect(enrolls()).toEqual([]);
  });

  test('--token without --signet enrolls nothing unless confirmed', async () => {
    calls.length = 0;
    const kcpHome = await home();
    await expect(loginWithToken({ home: kcpHome, url, apiToken })).rejects.toThrow(
      /Nothing enrolled.*--yes.*--signet/,
    );
    await expect(
      loginWithToken({ home: kcpHome, url, apiToken, confirm: async () => false }),
    ).rejects.toThrow(/Nothing enrolled/);
    expect(enrolls()).toEqual([]);
  });

  test('--token --signet enrolls just that one, with no confirmation, again if asked again', async () => {
    calls.length = 0;
    const kcpHome = await home();
    const confirm = async () => {
      throw Error('not asked');
    };
    const once = { home: kcpHome, url, apiToken, signetId: id(15), confirm };
    expect(await loginWithToken(once)).toEqual({ url, signetIds: [id(15)] });
    expect(await loginWithToken(once)).toEqual({ url, signetIds: [id(15)] });
    expect(enrolls().map((call) => (call.body as { signetId: string }).signetId)).toEqual([
      id(15),
      id(15),
    ]);
  });

  test("--token offers Signets issued to the person's memberships", async () => {
    const base = overview();
    const template = base.signets[0];
    if (!template) throw Error('fixture');
    currentOverview = {
      ...base,
      signets: [
        { ...template, id: id(41), recipientModel: 'OrganizationUser', recipientUserId: viewer },
        { ...template, id: id(42), recipientModel: 'SpaceUser', recipientUserId: viewer },
        { ...template, id: id(43), recipientModel: 'OrganizationUser', recipientUserId: id(600) },
      ],
      signetResources: [41, 42, 43].map((n) => grantRow(id(n), template.currentRevision, id(1))),
    };
    const offered: string[] = [];
    await loginWithToken({
      home: await home(),
      url,
      apiToken,
      confirm: async (candidates) => {
        offered.push(...candidates.map((candidate) => candidate.signetId));
        return true;
      },
    });
    expect(offered).toEqual([id(41), id(42)]);
  });

  test('two logins racing on one home enroll each Signet once: the hold lock serializes them', async () => {
    calls.length = 0;
    const kcpHome = await home();
    const login = () => loginWithToken({ home: kcpHome, url, apiToken, confirm: async () => true });
    const [first, second] = await Promise.all([login(), login()]);
    expect([...first.signetIds, ...second.signetIds].sort()).toEqual([id(11), id(14)]);
    expect(enrolls()).toHaveLength(2);
    expect(existsSync(join(installationPaths(kcpHome, url).directory, '.hold-lock'))).toBe(false);
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
  test('status describes each held Signet; logout deletes the key and Signets and names what to revoke', async () => {
    const kcpHome = await home();
    await holdSignet(kcpHome, url, { signetId: id(11), owner: orgOwner(tribe) });
    const holders = new SignetHolders({
      describe: async ({ signetId }) =>
        description({
          signetId,
          resources: [{ integrationId: id(1), provider: 'railway', resourceId: id(21) }],
        }),
    });
    const current = await status(kcpHome, url, holders);
    expect(current).toMatchObject({
      url,
      loggedIn: true,
      installation: null,
      pairingSupported: false,
      signets: [
        {
          signetId: id(11),
          integrations: [{ integrationId: id(1), provider: 'railway' }],
          owner: orgOwner(tribe),
          status: 'described',
        },
      ],
    });
    expect(await logout(kcpHome, url)).toEqual({
      url,
      removedSignetIds: [id(11)],
      withdrawnRegistrations: [],
      revokeInKingdom: { signetIds: [id(11)] },
    });
    expect(existsSync(installationPaths(kcpHome, url).directory)).toBe(false);
    expect((await status(kcpHome, url, holders)).loggedIn).toBe(false);
  });

  test("logout reports a withdrawal Kingdom refused, and names the pairing's Signet and integration", async () => {
    const kcpHome = await home();
    const { directory } = await holdSignet(kcpHome, url, {
      signetId: id(11),
      owner: orgOwner(tribe),
    });
    await writePrivateJson(join(directory, 'installation.json'), {
      integrationId: id(80),
      signetId: id(81),
      owner: orgOwner(tribe),
    });
    inquiriesStatus = 503;
    const removed = await logout(kcpHome, url);
    expect(removed).toMatchObject({
      withdrawnRegistrations: [],
      withdrawError: expect.stringContaining('503'),
      revokeInKingdom: { signetIds: [id(11), id(81)], integrationId: id(80) },
    });
    expect(existsSync(directory)).toBe(false);
  });
});
