import { describe, expect, test } from 'bun:test';
import type { OwnerRef } from '@inixiative/signet/contracts';
import { chooseSignet, type Reachable, resolveRoute } from '../src/routing';
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
  test('--signet reaching several integrations: the family narrows, then -i, else it is ambiguous', () => {
    const spanning: Reachable[] = [
      { ...tribeRailway, signetId: id(20) },
      { ...inixiativeRailway, signetId: id(20) },
      { ...aronGithub, signetId: id(20) },
    ];
    const signet = (selection: Selection, family: 'railway' | 'github' = 'railway') =>
      resolveRoute({ family, selection: { signetId: id(20), ...selection }, reachable: spanning });
    expect(signet({}, 'github')).toEqual({
      status: 'resolved',
      via: 'signet',
      integrationId: id(3),
      signetIds: [id(20)],
    });
    expect(signet({})).toMatchObject({
      status: 'ambiguous',
      choose: 'integration',
      candidates: [{ integrationId: id(1) }, { integrationId: id(2) }],
    });
    expect(signet({ integrationId: id(2) })).toMatchObject({
      status: 'resolved',
      integrationId: id(2),
    });
    expect(signet({ integrationId: id(3) })).toMatchObject({
      status: 'error',
      reason: expect.stringContaining('reaches no railway integration'),
    });
  });
  test('--signet wins over the project mapping', () => {
    expect(route({ signetId: id(12) }, { project: { integrationId: id(1) } })).toEqual({
      status: 'resolved',
      via: 'signet',
      integrationId: id(2),
      signetIds: [id(12)],
    });
  });
  test('--signet beside owner flags: agreeing is fine, contradicting is refused, not overridden', () => {
    expect(
      route({
        signetId: id(12),
        owner: { ownerModel: 'Organization', organizationId: inixiative },
      }),
    ).toMatchObject({ status: 'resolved', signetIds: [id(12)] });
    expect(
      route({ signetId: id(12), owner: { ownerModel: 'Organization', organizationId: tribe } }),
    ).toMatchObject({ status: 'error', reason: expect.stringContaining('pass one or the other') });
  });
  test('--signet that this machine does not hold, or that contradicts -i or the CLI, is an error', () => {
    expect(route({ signetId: id(99) }).status).toBe('error');
    expect(route({ signetId: id(12), integrationId: id(1) })).toMatchObject({
      status: 'error',
      reason: expect.stringContaining(`reaches no integration ${id(1)}`),
    });
    expect(route({ signetId: id(13) })).toMatchObject({
      status: 'error',
      reason: expect.stringContaining('github'),
    });
  });
  test('-i comes next; owner flags beside it must agree with its owner', () => {
    expect(
      route({ integrationId: id(1), owner: { ownerModel: 'Organization', organizationId: tribe } }),
    ).toEqual({
      status: 'resolved',
      via: 'integration',
      integrationId: id(1),
      signetIds: [id(11)],
    });
    expect(
      route({
        integrationId: id(1),
        owner: { ownerModel: 'Organization', organizationId: inixiative },
      }),
    ).toMatchObject({ status: 'error', reason: expect.stringContaining('-i belongs to') });
  });
  test('-i with owner flags this machine cannot check is refused', () => {
    expect(
      resolveRoute({
        family: 'railway',
        selection: {
          integrationId: id(1),
          owner: { ownerModel: 'Organization', organizationId: tribe },
        },
        reachable: [{ ...tribeRailway, owner: null }],
      }),
    ).toMatchObject({ status: 'error', reason: expect.stringContaining("Can't check -i") });
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
      signetIds: [id(11)],
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
      signetIds: [id(11)],
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
      signetIds: [id(13)],
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
  test('two Signets on one integration are one match, not ambiguous', () => {
    const second: Reachable = { ...tribeRailway, signetId: id(21) };
    expect(
      resolveRoute({ family: 'railway', selection: {}, reachable: [tribeRailway, second] }),
    ).toEqual({
      status: 'resolved',
      via: 'single',
      integrationId: id(1),
      signetIds: [id(11), id(21)],
    });
    expect(
      resolveRoute({
        family: 'railway',
        selection: { owner: { ownerModel: 'Organization', organizationId: tribe } },
        reachable: [tribeRailway, second, inixiativeRailway],
      }),
    ).toMatchObject({ status: 'resolved', integrationId: id(1), signetIds: [id(11), id(21)] });
  });
});

describe('chooseSignet', () => {
  const grants = (signetId: string, operation: string, resourceId: string) => ({
    ...tribeRailway,
    signetId,
    grants: [{ operation, resourceIds: [resourceId] }],
  });
  const parsed = { operation: 'railway.logs.read', resourceId: id(40) };
  test('the only held Signet is used, whatever it grants: Kingdom judges', () => {
    const only = grants(id(11), 'railway.status.read', id(41));
    expect(chooseSignet([only], parsed, 'railway')).toEqual({ status: 'chosen', signet: only });
  });
  test('among several, the one that grants the operation on the resource', () => {
    const logs = grants(id(21), 'railway.logs.read', id(40));
    expect(
      chooseSignet(
        [grants(id(11), 'railway.logs.read', id(41)), logs, grants(id(22), 'other', id(40))],
        parsed,
        'railway',
      ),
    ).toEqual({ status: 'chosen', signet: logs });
  });
  test('several, none granting it: ambiguous, naming each --signet', () => {
    expect(
      chooseSignet(
        [
          grants(id(11), 'railway.status.read', id(40)),
          grants(id(21), 'railway.logs.read', id(41)),
        ],
        parsed,
        'railway',
      ),
    ).toMatchObject({
      status: 'ambiguous',
      choose: 'signet',
      reason: expect.stringContaining('--signet'),
    });
  });
});
