import { describe, expect, test } from 'bun:test';
import type { OwnerRef } from '@inixiative/signet/contracts';
import { type Reachable, resolveRoute } from '../src/routing';
import type { Selection } from '../src/selectors';

const id = (n: number) => `01a196f0-a68e-7d81-a8cd-${String(n).padStart(12, '0')}`;
const tribe = id(100);
const inixiative = id(101);
const aron = id(102);
const orgOwner = (organizationId: string): OwnerRef => ({
  ownerModel: 'Organization',
  userId: null,
  organizationId,
  spaceId: null,
});
const membership: OwnerRef = {
  ownerModel: 'OrganizationUser',
  userId: aron,
  organizationId: inixiative,
  spaceId: null,
};

const tribeRailway: Reachable = {
  integrationId: id(1),
  provider: 'railway',
  owner: orgOwner(tribe),
  signetId: id(11),
};
const inixiativeRailway: Reachable = {
  integrationId: id(2),
  provider: 'railway',
  owner: orgOwner(inixiative),
  signetId: id(12),
};
const aronGithub: Reachable = {
  integrationId: id(3),
  provider: 'github',
  owner: membership,
  signetId: id(13),
};
const unheldVercel: Reachable = { integrationId: id(4), provider: 'vercel', owner: membership };
const reachable = [tribeRailway, inixiativeRailway, aronGithub, unheldVercel];

const route = (
  selection: Selection,
  extra: { project?: Selection; family?: 'railway' | 'github' | 'vercel' | 'infisical' } = {},
) =>
  resolveRoute({
    family: extra.family ?? 'railway',
    selection,
    reachable,
    ...(extra.project ? { project: extra.project } : {}),
  });

describe('resolveRoute (§5 order)', () => {
  test('--signet wins over everything else', () => {
    expect(
      route(
        { signetId: id(12), owner: { ownerModel: 'Organization', organizationId: tribe } },
        { project: { integrationId: id(1) } },
      ),
    ).toEqual({ status: 'resolved', via: 'signet', integrationId: id(2), signetId: id(12) });
  });
  test('--signet that this machine does not hold, or that contradicts -i or the CLI, is an error', () => {
    expect(route({ signetId: id(99) }).status).toBe('error');
    expect(route({ signetId: id(12), integrationId: id(1) })).toMatchObject({
      status: 'error',
      reason: expect.stringContaining('not -i'),
    });
    expect(route({ signetId: id(13) })).toMatchObject({
      status: 'error',
      reason: expect.stringContaining('github'),
    });
  });
  test('--token names no integration grant', () => {
    expect(route({ tokenId: id(50) })).toMatchObject({ status: 'error' });
  });
  test('-i comes next, and overrides the owner flags', () => {
    expect(
      route({
        integrationId: id(1),
        owner: { ownerModel: 'Organization', organizationId: inixiative },
      }),
    ).toEqual({
      status: 'resolved',
      via: 'integration',
      integrationId: id(1),
      signetId: id(11),
    });
  });
  test('-i of another provider is an error; -i without a held Signet asks the owner', () => {
    expect(route({ integrationId: id(3) }).status).toBe('error');
    expect(route({ integrationId: id(4) }, { family: 'vercel' })).toMatchObject({
      status: 'ask',
      integrationId: id(4),
    });
    expect(route({ integrationId: id(77) })).toMatchObject({
      status: 'ask',
      integrationId: id(77),
    });
  });
  test('owner flags pick that owner’s one integration of the family', () => {
    expect(route({ owner: { ownerModel: 'Organization', organizationId: tribe } })).toEqual({
      status: 'resolved',
      via: 'owner',
      integrationId: id(1),
      signetId: id(11),
    });
    expect(
      route(
        { owner: { ownerModel: 'OrganizationUser', organizationId: inixiative, userId: aron } },
        { family: 'github' },
      ),
    ).toMatchObject({ status: 'resolved', integrationId: id(3) });
  });
  test('owner flags with nothing of the family ask that owner', () => {
    expect(route({ owner: { ownerModel: 'User', userId: aron } })).toMatchObject({
      status: 'ask',
      owner: { ownerModel: 'User', userId: aron },
    });
  });
  test('with no flags, the project mapping', () => {
    expect(
      route({}, { project: { owner: { ownerModel: 'Organization', organizationId: tribe } } }),
    ).toEqual({
      status: 'resolved',
      via: 'project',
      integrationId: id(1),
      signetId: id(11),
    });
    expect(route({}, { project: { integrationId: id(2) } })).toMatchObject({
      via: 'project',
      integrationId: id(2),
    });
  });
  test('flags beat the project mapping', () => {
    expect(route({ integrationId: id(2) }, { project: { integrationId: id(1) } })).toMatchObject({
      via: 'integration',
      integrationId: id(2),
    });
  });
  test('then the single matching integration', () => {
    expect(route({}, { family: 'github' })).toEqual({
      status: 'resolved',
      via: 'single',
      integrationId: id(3),
      signetId: id(13),
    });
  });
  test('several matches are ambiguous; none asks the owner', () => {
    expect(route({})).toMatchObject({
      status: 'ambiguous',
      candidates: [tribeRailway, inixiativeRailway],
    });
    expect(route({}, { family: 'infisical' })).toMatchObject({
      status: 'ask',
      family: 'infisical',
    });
    expect(route({}, { family: 'vercel' })).toMatchObject({ status: 'ask', integrationId: id(4) });
  });
  test('an integration whose owner this machine does not know never matches owner flags', () => {
    expect(
      resolveRoute({
        family: 'railway',
        selection: { owner: { ownerModel: 'Organization', organizationId: tribe } },
        reachable: [{ ...tribeRailway, owner: null }],
      }).status,
    ).toBe('ask');
  });
});
