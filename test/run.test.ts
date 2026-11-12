import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installationPaths,
  SignetHolders,
  SignetHttpError,
  writePrivateJson,
} from '@inixiative/signet';
import { NoOperationsError, type OperationParser } from '../src/operations';
import { heldReach, RouteError, runCommand } from '../src/run';
import { description, holdSignet, id, orgOwner, tribe } from './fixtures';

/** A loopback Kingdom that only counts what reaches it. */
let requests = 0;
let kingdom: ReturnType<typeof Bun.serve>;
let url = '';
beforeAll(() => {
  kingdom = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      requests++;
      return new Response('not found', { status: 404 });
    },
  });
  url = `http://127.0.0.1:${kingdom.port}`;
});
afterAll(() => kingdom.stop(true));
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const home = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcp-home-'));
  homes.push(directory);
  return directory;
};

const railway = { signetId: id(11), owner: orgOwner(tribe) };
/** Signet → the operation its description grants on resource id(21). */
const granted: Record<string, string> = { [id(16)]: 'documents.read' };
let described = 0;
const holders = () =>
  new SignetHolders({
    describe: async ({ signetId }) => {
      described++;
      if (signetId === id(19)) throw new SignetHttpError(403);
      const answer = description({
        signetId,
        resources: [
          { integrationId: id(1), provider: 'railway', resourceId: id(21) },
          // id(20) reaches a second Railway integration too.
          ...(signetId === id(20)
            ? [{ integrationId: id(2), provider: 'railway', resourceId: id(22) }]
            : []),
        ],
      });
      return {
        ...answer,
        operations: answer.operations.map((operation) => ({
          ...operation,
          key: granted[signetId] ?? 'documents.search',
        })),
      };
    },
  });
const search: OperationParser = (_args, context) => {
  const resource = context.resources[0];
  return resource
    ? { operation: 'documents.search', resourceId: resource.id, input: { query: 'deploy' } }
    : { refused: 'no service' };
};

describe('runCommand', () => {
  test('no parser for the provider: refused before any call to Kingdom', async () => {
    const kcpHome = await home();
    await holdSignet(kcpHome, url, railway);
    // Paired, so a sync would otherwise call Kingdom first.
    await writePrivateJson(join(installationPaths(kcpHome, url).directory, 'installation.json'), {
      integrationId: id(80),
      signetId: id(81),
      owner: orgOwner(tribe),
    });
    requests = 0;
    described = 0;
    const run = runCommand({
      argv: ['railway', 'logs'],
      home: kcpHome,
      url,
      cwd: kcpHome,
      holders: holders(),
    });
    await expect(run).rejects.toThrow(NoOperationsError);
    await expect(run).rejects.toThrow(/No operations are declared for railway yet/);
    expect(requests).toBe(0);
    expect(described).toBe(0);
  });
  test('with nothing held, asks the owner before any parsing', async () => {
    const run = runCommand({
      argv: ['gh', 'pr', 'list'],
      home: await home(),
      url,
      cwd: '/',
      holders: holders(),
      parsers: { github: () => ({ refused: 'never reached' }) },
    });
    await expect(run).rejects.toThrow(RouteError);
    await expect(run).rejects.toThrow(/Ask the integration's owner/);
  });
  test('a parsed command is executed as typed input through the routed Signet, never as argv', async () => {
    const kcpHome = await home();
    const { credentialFile } = await holdSignet(kcpHome, url, railway);
    const seen: { args: readonly string[]; resources: unknown } = { args: [], resources: null };
    const parser: OperationParser = (args, context) => {
      seen.args = args;
      seen.resources = context.resources;
      const resource = context.resources[0];
      return resource
        ? { operation: 'documents.search', resourceId: resource.id, input: { query: 'deploy' } }
        : { refused: 'no service' };
    };
    const executed: unknown[] = [];
    const result = await runCommand({
      argv: ['-o', tribe, 'railway', 'logs', '--service', 'api'],
      home: kcpHome,
      url,
      cwd: kcpHome,
      holders: holders(),
      parsers: { railway: parser },
      execute: async (file, request) => {
        executed.push({ file, request });
        return { executionId: id(70), result: 'ok' };
      },
    });
    expect(result).toEqual({ executionId: id(70), result: 'ok' });
    expect(seen.args).toEqual(['logs', '--service', 'api']);
    expect(seen.resources).toEqual([{ id: id(21), name: 'api', kind: 'service' }]);
    expect(executed).toEqual([
      {
        file: credentialFile,
        request: {
          integrationId: id(1),
          operation: 'documents.search',
          input: { resourceId: id(21), query: 'deploy', limit: 20 },
        },
      },
    ]);
  });
  test('a refusal names why and sends nothing', async () => {
    const kcpHome = await home();
    await holdSignet(kcpHome, url, railway);
    let sent = false;
    const run = runCommand({
      argv: ['railway', 'run', 'bash'],
      home: kcpHome,
      url,
      cwd: kcpHome,
      holders: holders(),
      parsers: { railway: () => ({ refused: 'railway run is not an operation' }) },
      execute: async () => {
        sent = true;
        return null;
      },
    });
    await expect(run).rejects.toThrow('railway: railway run is not an operation');
    await run.catch(() => {});
    expect(sent).toBe(false);
  });
});

describe('one Signet on several integrations', () => {
  test('--signet alone is ambiguous; -i picks the integration and only its resources are parsed', async () => {
    const kcpHome = await home();
    const { credentialFile } = await holdSignet(kcpHome, url, { ...railway, signetId: id(20) });
    const ambiguous = runCommand({
      argv: ['--signet', id(20), 'railway', 'logs'],
      home: kcpHome,
      url,
      cwd: kcpHome,
      holders: holders(),
      parsers: { railway: search },
    });
    await expect(ambiguous).rejects.toThrow(RouteError);
    await expect(ambiguous).rejects.toThrow(
      new RegExp(`reaches 2 railway integrations[\\s\\S]*-i ${id(1)}[\\s\\S]*-i ${id(2)}`),
    );
    const executed: unknown[] = [];
    await runCommand({
      argv: ['--signet', id(20), '-i', id(2), 'railway', 'logs'],
      home: kcpHome,
      url,
      cwd: kcpHome,
      holders: holders(),
      parsers: { railway: search },
      execute: async (file, request) => {
        executed.push({ file, request });
        return null;
      },
    });
    expect(executed).toEqual([
      {
        file: credentialFile,
        request: {
          integrationId: id(2),
          operation: 'documents.search',
          input: { resourceId: id(22), query: 'deploy', limit: 20 },
        },
      },
    ]);
  });
});

describe('several Signets on one integration', () => {
  const execute = (seen: string[]) => async (file: string) => {
    seen.push(file);
    return null;
  };
  test('parses first, then runs through the Signet that grants the operation on the resource', async () => {
    const kcpHome = await home();
    await holdSignet(kcpHome, url, { ...railway, signetId: id(16) });
    const { credentialFile } = await holdSignet(kcpHome, url, railway);
    const seen: string[] = [];
    await runCommand({
      argv: ['-i', id(1), 'railway', 'logs'],
      home: kcpHome,
      url,
      cwd: kcpHome,
      holders: holders(),
      parsers: { railway: search },
      execute: execute(seen),
    });
    expect(seen).toEqual([credentialFile]);
  });
  test('none granting it is ambiguous, naming each --signet, and sends nothing', async () => {
    const kcpHome = await home();
    await holdSignet(kcpHome, url, { ...railway, signetId: id(16) });
    await holdSignet(kcpHome, url, { ...railway, signetId: id(17) });
    granted[id(17)] = 'documents.read';
    const seen: string[] = [];
    const run = runCommand({
      argv: ['-i', id(1), 'railway', 'logs'],
      home: kcpHome,
      url,
      cwd: kcpHome,
      holders: holders(),
      parsers: { railway: search },
      execute: execute(seen),
    });
    await expect(run).rejects.toThrow(RouteError);
    await expect(run).rejects.toThrow(new RegExp(`--signet ${id(16)}[\\s\\S]*--signet ${id(17)}`));
    expect(seen).toEqual([]);
    delete granted[id(17)];
  });
});

describe('heldReach', () => {
  test('leaves out Signets Kingdom refuses', async () => {
    const kcpHome = await home();
    await holdSignet(kcpHome, url, railway);
    await holdSignet(kcpHome, url, { signetId: id(19) });
    const reach = await heldReach(kcpHome, url, holders());
    expect(reach.map((item) => item.signetId)).toEqual([id(11)]);
    expect(reach[0]).toMatchObject({ provider: 'railway', owner: orgOwner(tribe) });
  });
});
