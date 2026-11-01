import { describe, expect, test } from 'bun:test';
import {
  gitRefusal,
  ownerFromIds,
  parseCommand,
  providerFamilyOf,
  SelectorError,
} from '../src/selectors';

const org = '01a196f0-a68e-7d81-a8cd-fc92e07fb9bf';
const user = '01a196f0-a68e-7d81-a8cd-000000000001';
const space = '01a196f0-a68e-7d81-a8cd-000000000002';
const integration = '01a196f0-a68e-7d81-a8cd-000000000003';
const signet = '01a196f0-a68e-7d81-a8cd-000000000004';

describe('providerFamilyOf', () => {
  test('maps each proxied binary to its provider family', () => {
    expect(providerFamilyOf('railway')).toBe('railway');
    expect(providerFamilyOf('gh')).toBe('github');
    expect(providerFamilyOf('git')).toBeNull();
    expect(providerFamilyOf('vercel')).toBe('vercel');
    expect(providerFamilyOf('infisical')).toBe('infisical');
    expect(providerFamilyOf('ssh')).toBeNull();
    expect(providerFamilyOf('constructor')).toBeNull();
  });
});

describe('ownerFromIds', () => {
  test('one flag names that owner', () => {
    expect(ownerFromIds({ organizationId: org })).toEqual({
      ownerModel: 'Organization',
      organizationId: org,
    });
    expect(ownerFromIds({ userId: user })).toEqual({ ownerModel: 'User', userId: user });
    expect(ownerFromIds({ spaceId: space })).toEqual({ ownerModel: 'Space', spaceId: space });
  });
  test('-o with -u is the organization membership, -s with -u the space membership', () => {
    expect(ownerFromIds({ organizationId: org, userId: user })).toEqual({
      ownerModel: 'OrganizationUser',
      organizationId: org,
      userId: user,
    });
    expect(ownerFromIds({ spaceId: space, userId: user })).toEqual({
      ownerModel: 'SpaceUser',
      spaceId: space,
      userId: user,
    });
    expect(ownerFromIds({ organizationId: org, spaceId: space, userId: user })).toEqual({
      ownerModel: 'SpaceUser',
      organizationId: org,
      spaceId: space,
      userId: user,
    });
  });
  test('no owner flags, no owner', () => {
    expect(ownerFromIds({})).toBeUndefined();
  });
});

describe('parseCommand', () => {
  test('selectors come first; everything after the CLI is its own', () => {
    const parsed = parseCommand(['-o', org, '-u', user, 'railway', 'logs', '-s', 'api']);
    expect(parsed).toEqual({
      selection: { owner: { ownerModel: 'OrganizationUser', organizationId: org, userId: user } },
      binary: 'railway',
      family: 'railway',
      args: ['logs', '-s', 'api'],
    });
  });
  test('-i and --signet, inline or spaced', () => {
    expect(parseCommand(['-i', integration, 'gh', 'pr', 'list']).selection).toEqual({
      integrationId: integration,
    });
    expect(parseCommand([`--signet=${signet}`, 'vercel', 'ls']).selection).toEqual({
      signetId: signet,
    });
  });
  test('-i alongside owner flags keeps both; routing checks they agree', () => {
    expect(parseCommand(['-i', integration, '-o', org, 'railway']).selection).toEqual({
      integrationId: integration,
      owner: { ownerModel: 'Organization', organizationId: org },
    });
  });
  test('refuses what it cannot read', () => {
    const refuses = (argv: string[], message: RegExp) =>
      expect(() => parseCommand(argv)).toThrow(message);
    refuses(['-o', 'tribe', 'railway'], /-o takes a UUID/);
    refuses(['--token', signet, 'infisical'], /--token is not an integration selector/);
    refuses([`--token=${signet}`, 'railway'], /only Kingdom's own API/);
    refuses(['-i', integration, '-i', signet, 'railway'], /twice/);
    refuses(['-i'], /needs an id/);
    refuses(['-i', '-o', org, 'railway'], /needs an id/);
    refuses(['--force', 'railway'], /Unknown selector --force/);
    refuses(['-o', org], /Name the CLI/);
    refuses(['ssh', 'host'], /does not proxy ssh/);
    expect(() => parseCommand(['ssh'])).toThrow(SelectorError);
  });
  test('the same id twice is fine', () => {
    expect(parseCommand(['-i', integration, '-i', integration, 'gh']).selection).toEqual({
      integrationId: integration,
    });
  });
  test('git is the local credential-helper path, never a Kingdom execute', () => {
    expect(() => parseCommand(['git', 'push'])).toThrow(gitRefusal);
    expect(() => parseCommand(['-i', integration, 'git', 'fetch'])).toThrow(/credential helper/);
  });
});
