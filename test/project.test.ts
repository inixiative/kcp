import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectFile, kcpProjectSchema, projectSelections, readProject } from '../src/project';

const org = '01a196f0-a68e-7d81-a8cd-fc92e07fb9bf';
const integration = '01a196f0-a68e-7d81-a8cd-000000000003';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const temporary = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcp-project-'));
  directories.push(directory);
  return directory;
};

describe('.foundry/kcp.json', () => {
  test('maps a provider to an integration or an owner, as the flags would', () => {
    const project = kcpProjectSchema.parse({
      providers: { railway: { organizationId: org }, github: { integrationId: integration } },
    });
    expect(projectSelections(project)).toEqual({
      railway: { owner: { ownerModel: 'Organization', organizationId: org } },
      github: { integrationId: integration },
    });
  });
  test('refuses unknown providers, empty routes, extra keys and non-UUIDs', () => {
    expect(
      kcpProjectSchema.safeParse({ providers: { ssh: { organizationId: org } } }).success,
    ).toBe(false);
    expect(kcpProjectSchema.safeParse({ providers: { railway: {} } }).success).toBe(false);
    expect(kcpProjectSchema.safeParse({ providers: {}, extra: 1 }).success).toBe(false);
    expect(
      kcpProjectSchema.safeParse({ providers: { railway: { organizationId: 'tribe' } } }).success,
    ).toBe(false);
  });
  test('found from a subdirectory, up to the repo root only', async () => {
    const outer = await temporary();
    const repo = join(outer, 'repo');
    const nested = join(repo, 'apps', 'api');
    await mkdir(join(repo, '.foundry'), { recursive: true });
    await mkdir(join(repo, '.git'));
    await mkdir(nested, { recursive: true });
    const file = join(repo, '.foundry', 'kcp.json');
    await writeFile(
      file,
      JSON.stringify({ providers: { railway: { integrationId: integration } } }),
    );
    expect(findProjectFile(nested)).toBe(file);
    expect((await readProject(file)).providers.railway).toEqual({ integrationId: integration });

    const other = join(outer, 'other');
    await mkdir(join(other, '.git'), { recursive: true });
    await mkdir(join(outer, '.foundry'));
    await writeFile(join(outer, '.foundry', 'kcp.json'), '{"providers":{}}');
    expect(findProjectFile(other)).toBeNull();
  });
  test('outside a repo there is no mapping: a cwd without .git finds none', async () => {
    const outer = await temporary();
    const cwd = join(outer, 'scratch', 'deeper');
    await mkdir(cwd, { recursive: true });
    await mkdir(join(outer, 'scratch', '.foundry'));
    await writeFile(join(outer, 'scratch', '.foundry', 'kcp.json'), '{"providers":{}}');
    expect(findProjectFile(cwd, outer)).toBeNull();
  });
  test('never walks above home, even to a repo there', async () => {
    const outer = await temporary();
    const home = join(outer, 'home');
    const cwd = join(home, 'notes');
    await mkdir(cwd, { recursive: true });
    await mkdir(join(outer, '.git'));
    await mkdir(join(outer, '.foundry'));
    await writeFile(join(outer, '.foundry', 'kcp.json'), '{"providers":{}}');
    expect(findProjectFile(cwd, home)).toBeNull();
    await mkdir(join(home, '.git'));
    expect(findProjectFile(cwd, home)).toBeNull();
    await mkdir(join(home, '.foundry'));
    await writeFile(join(home, '.foundry', 'kcp.json'), '{"providers":{}}');
    expect(findProjectFile(cwd, home)).toBe(join(home, '.foundry', 'kcp.json'));
  });
  test('an invalid file says where and why', async () => {
    const directory = await temporary();
    const file = join(directory, 'kcp.json');
    await writeFile(file, JSON.stringify({ providers: { railway: { spaceId: 'x' } } }));
    await expect(readProject(file)).rejects.toThrow(/providers\.railway\.spaceId/);
  });
});
