import { join } from 'node:path';
import { generateSignetKey, installationPaths, writePrivateJson } from '@inixiative/signet';
import type { OwnerRef } from '@inixiative/signet/contracts';

export const id = (n: number) => `01a196f0-a68e-7d81-a8cd-${String(n).padStart(12, '0')}`;
export const token43 = (seed: string) => seed.repeat(43).slice(0, 43);
export const viewer = id(500);
export const tribe = id(501);

export const orgOwner = (organizationId: string): OwnerRef => ({
  ownerModel: 'Organization',
  userId: null,
  organizationId,
  spaceId: null,
});

const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

export const credentials = () => ({
  enrollmentId: id(900),
  lifecycle: 'ongoing' as const,
  taskId: null,
  accessToken: `kingdom_${token43('a')}`,
  renewalCredential: `signet_renew_${token43('b')}`,
  expiresAt: later(1),
  renewalExpiresAt: later(300),
  idleExpiresAt: later(30),
  tokenType: 'DPoP' as const,
});

/** Writes a device key and one held Signet credential under `home` for `url`. */
export async function holdSignet(
  home: string,
  url: string,
  signet: { signetId: string; owner?: OwnerRef },
) {
  const { directory, keyFile } = installationPaths(home, url);
  await writePrivateJson(keyFile, generateSignetKey());
  const credentialFile = join(directory, `signet-${signet.signetId}.json`);
  await writePrivateJson(credentialFile, { ...credentials(), ...signet, url, keyFile });
  return { credentialFile, keyFile, directory };
}

/**
 * An `access/describe` answer for a Signet with one resource on each integration named (a Signet
 * has no integration of its own; each resource names its own).
 */
export const description = (signet: {
  signetId: string;
  resources: { integrationId: string; provider: string; resourceId: string }[];
}) => ({
  signetId: signet.signetId,
  name: 'Agent access',
  expiresAt: null,
  lifecycle: 'ongoing',
  taskId: null,
  currentRevision: 1,
  remainingRequests: null,
  operations: [
    {
      key: 'logs.read',
      name: 'Read logs',
      resources: signet.resources.map((resource) => ({
        id: resource.resourceId,
        name: 'api',
        kind: 'service',
        integrationId: resource.integrationId,
        provider: resource.provider,
        lens: [],
      })),
    },
  ],
  holder: null,
});

const ownerGroup = (owner: OwnerRef, name: string) => ({
  id: [owner.ownerModel, owner.userId ?? '', owner.organizationId ?? '', owner.spaceId ?? ''].join(
    ':',
  ),
  name,
  membershipId: null,
  ...owner,
});

/** One grant row of a Signet revision, on a resource of `integrationId`. */
export const grantRow = (signetId: string, number: number, integrationId: string) => ({
  id: Bun.randomUUIDv7(),
  revision: { signetId, number },
  grant: {
    resourceModel: 'IntegrationResource',
    integrationResourceId: Bun.randomUUIDv7(),
    kind: 'service',
    integrationId,
    full: true,
  },
  selection: null,
});

/** A trimmed `/me/overview`: the viewer, Tribe's Railway, and one Signet issued to the viewer. */
export const overview = () => {
  const personal: OwnerRef = {
    ownerModel: 'User',
    userId: viewer,
    organizationId: null,
    spaceId: null,
  };
  return {
    dashboard: { viewerUserId: viewer, ownedIntegrationIds: [], sharedCapacities: [] },
    managedIntegrationIds: [id(1)],
    owners: [ownerGroup(personal, 'Personal'), ownerGroup(orgOwner(tribe), 'Tribe')],
    integrationOwners: [ownerGroup(personal, 'Personal'), ownerGroup(orgOwner(tribe), 'Tribe')],
    integrations: [
      {
        id: id(1),
        name: 'Tribe Railway',
        provider: 'railway',
        enabled: true,
        deletedAt: null,
        ...orgOwner(tribe),
      },
      {
        id: id(3),
        name: 'Tribe GitHub',
        provider: 'githubOrganization',
        enabled: true,
        deletedAt: null,
        ...orgOwner(tribe),
      },
      {
        id: id(5),
        name: 'Tribe Gmail',
        provider: 'gmail',
        enabled: true,
        deletedAt: null,
        ...orgOwner(tribe),
      },
      {
        id: id(2),
        name: 'Old',
        provider: 'github',
        enabled: true,
        deletedAt: new Date().toISOString(),
        ...orgOwner(tribe),
      },
    ],
    resources: [
      {
        id: id(21),
        integrationId: id(1),
        name: 'api',
        kind: 'service',
        enabled: true,
        externalId: 'x',
      },
      {
        id: id(22),
        integrationId: id(1),
        name: 'old',
        kind: 'service',
        enabled: false,
        externalId: 'y',
      },
    ],
    signets: [
      {
        id: id(11),
        name: 'Railway for Aron',
        recipientModel: 'User',
        recipientUserId: viewer,
        recipientIntegrationId: null,
        currentRevision: 3,
        expiresAt: null,
        revokedAt: null,
        closedAt: null,
        deletedAt: null,
      },
      {
        id: id(14),
        name: 'GitHub for Aron',
        recipientModel: 'User',
        recipientUserId: viewer,
        recipientIntegrationId: null,
        currentRevision: 1,
        expiresAt: null,
        revokedAt: null,
        closedAt: null,
        deletedAt: null,
      },
      {
        id: id(15),
        name: 'Gmail for Aron',
        recipientModel: 'User',
        recipientUserId: viewer,
        recipientIntegrationId: null,
        currentRevision: 1,
        expiresAt: null,
        revokedAt: null,
        closedAt: null,
        deletedAt: null,
      },
      {
        id: id(12),
        name: 'Revoked',
        recipientModel: 'User',
        recipientUserId: viewer,
        recipientIntegrationId: null,
        currentRevision: 1,
        expiresAt: null,
        revokedAt: new Date().toISOString(),
        closedAt: null,
        deletedAt: null,
      },
      {
        id: id(13),
        name: 'Someone else',
        recipientModel: 'User',
        recipientUserId: id(600),
        recipientIntegrationId: null,
        currentRevision: 1,
        expiresAt: null,
        revokedAt: null,
        closedAt: null,
        deletedAt: null,
      },
    ],
    signetResources: [
      // A superseded revision's row never counts toward a Signet's reach.
      grantRow(id(11), 2, id(3)),
      grantRow(id(11), 3, id(1)),
      grantRow(id(14), 1, id(3)),
      grantRow(id(15), 1, id(5)),
      grantRow(id(12), 1, id(1)),
      grantRow(id(13), 1, id(1)),
    ],
    providers: [
      { key: 'railway', name: 'Railway' },
      { key: 'githubOrganization', name: 'GitHub organization', family: 'github' },
      { key: 'gmail', name: 'Gmail', family: 'google' },
    ],
  };
};
