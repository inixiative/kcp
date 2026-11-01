import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignetHttpError } from '@inixiative/signet';
import { SignetHolders } from '../src/holders';
import { NoOperationsError, type OperationParser } from '../src/operations';
import { heldReach, RouteError, runCommand } from '../src/run';
import { description, holdSignet, id, orgOwner, tribe } from './fixtures';

const url = 'http://localhost:4100';
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const home = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcp-home-'));
  homes.push(directory);
  return directory;
};

const railway = { signetId: id(11), integrationId: id(1), owner: orgOwner(tribe) };
const holders = () =>
  new SignetHolders({
    describe: async ({ signetId }) => {
      if (signetId === id(19)) throw new SignetHttpError(403);
      return description({
        signetId,
        integrationId: id(1),
        provider: 'railway',
        resourceId: id(21),
      });
    },
  });

describe('runCommand', () => {
  test('routes, then refuses: no operations are declared for the provider yet', async () => {
    const kcpHome = await home();
    await holdSignet(kcpHome, url, railway);
    const run = runCommand({
      argv: ['railway', 'logs'],
      home: kcpHome,
      url,
      cwd: kcpHome,
      holders: holders(),
    });
    await expect(run).rejects.toThrow(NoOperationsError);
    await expect(run).rejects.toThrow(/No operations are declared for railway yet/);
  });
  test('with nothing held, asks the owner before any parsing', async () => {
    const run = runCommand({
      argv: ['gh', 'pr', 'list'],
      home: await home(),
      url,
      cwd: '/',
      holders: holders(),
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

describe('heldReach', () => {
  test('leaves out Signets Kingdom refuses', async () => {
    const kcpHome = await home();
    await holdSignet(kcpHome, url, railway);
    await holdSignet(kcpHome, url, { signetId: id(19), integrationId: id(1) });
    const reach = await heldReach(kcpHome, url, holders());
    expect(reach.map((item) => item.signetId)).toEqual([id(11)]);
    expect(reach[0]).toMatchObject({ provider: 'railway', owner: orgOwner(tribe) });
  });
});
