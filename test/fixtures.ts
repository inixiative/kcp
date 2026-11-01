import { join } from 'node:path';
import { generateSignetKey, writePrivateJson } from '@inixiative/signet';
import type { OwnerRef } from '@inixiative/signet/contracts';
import { installationPaths } from '../src/installation';

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
  signet: { signetId: string; integrationId: string; owner?: OwnerRef },
) {
  const { directory, keyFile } = installationPaths(home, url);
  await writePrivateJson(keyFile, generateSignetKey());
  const credentialFile = join(directory, `signet-${signet.signetId}.json`);
  await writePrivateJson(credentialFile, { ...credentials(), ...signet, url, keyFile });
  return { credentialFile, keyFile, directory };
}

/** An `access/describe` answer for a Signet on one integration with one resource. */
export const description = (signet: {
  signetId: string;
  integrationId: string;
  provider: string | null;
  resourceId: string;
}) => ({
  signetId: signet.signetId,
  integrationId: signet.integrationId,
  provider: signet.provider,
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
      resources: [
        {
          id: signet.resourceId,
          name: 'api',
          kind: 'service',
          integrationId: signet.integrationId,
          lens: {},
        },
      ],
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
        integrationId: id(1),
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
        id: id(12),
        name: 'Revoked',
        integrationId: id(1),
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
        integrationId: id(1),
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
    providers: [],
  };
};
