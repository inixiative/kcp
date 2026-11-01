import { kingdomUrl, SignetHttpError } from '@inixiative/signet';
import { ownerRefSchema } from '@inixiative/signet/contracts';
import { z } from 'zod';
import { ownerKey } from './owner';
import type { Reachable } from './routing';

const ownerGroupSchema = ownerRefSchema.extend({
  id: z.string(),
  name: z.string(),
  membershipId: z.uuid().nullable(),
});

/**
 * The part of `GET /api/v1/me/overview` KCP reads. Objects strip what KCP doesn't read, so the
 * overview may grow without breaking KCP.
 */
export const overviewSchema = z.object({
  dashboard: z.object({ viewerUserId: z.uuid() }),
  managedIntegrationIds: z.array(z.uuid()),
  owners: z.array(ownerGroupSchema),
  integrationOwners: z.array(ownerGroupSchema),
  integrations: z.array(
    ownerRefSchema.extend({
      id: z.uuid(),
      name: z.string(),
      provider: z.string().nullable(),
      enabled: z.boolean(),
      deletedAt: z.coerce.date().nullable(),
    }),
  ),
  resources: z.array(
    z.object({
      id: z.uuid(),
      integrationId: z.uuid(),
      name: z.string(),
      kind: z.string(),
      enabled: z.boolean(),
    }),
  ),
  signets: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      integrationId: z.uuid(),
      recipientModel: z.string(),
      recipientUserId: z.uuid().nullable(),
      recipientIntegrationId: z.uuid().nullable(),
      currentRevision: z.number().int(),
      expiresAt: z.coerce.date().nullable(),
      revokedAt: z.coerce.date().nullable(),
      closedAt: z.coerce.date().nullable(),
      deletedAt: z.coerce.date().nullable(),
    }),
  ),
});
export type Overview = z.infer<typeof overviewSchema>;
export type OverviewSignet = Overview['signets'][number];

/**
 * Reads the overview as the person a Kingdom API token belongs to. The overview is a user route:
 * it takes a JWT or an API token, not a Signet presentation.
 */
export async function readOverview(url: string, apiToken: string, transport: typeof fetch = fetch) {
  const response = await transport(`${kingdomUrl(url)}/api/v1/me/overview`, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SignetHttpError(response.status, 'Kingdom refused the overview');
  }
  return overviewSchema.parse(z.object({ data: z.unknown() }).parse(await response.json()).data);
}

/** A Signet issued to the viewer that can still be enrolled. */
export const enrollableSignets = (overview: Overview, now = new Date()) =>
  overview.signets.filter(
    (signet) =>
      signet.recipientModel === 'User' &&
      signet.recipientUserId === overview.dashboard.viewerUserId &&
      !signet.revokedAt &&
      !signet.closedAt &&
      !signet.deletedAt &&
      (!signet.expiresAt || signet.expiresAt > now),
  );

export type MapIntegration = {
  id: string;
  name: string;
  provider: string | null;
  enabled: boolean;
  manages: boolean;
  /** Signets this machine holds on it. */
  held: string[];
  resources: { id: string; name: string; kind: string }[];
};
export type MapOwner = {
  key: string;
  name: string;
  owner: z.infer<typeof ownerRefSchema>;
  integrations: MapIntegration[];
};

/** Owners → integrations, every owner the viewer can reach, with the Signets this machine holds. */
export function kingdomMap(overview: Overview, heldSignetIds: ReadonlySet<string> = new Set()) {
  const live = overview.integrations.filter((integration) => !integration.deletedAt);
  const heldOn = (integrationId: string) =>
    overview.signets
      .filter((signet) => signet.integrationId === integrationId && heldSignetIds.has(signet.id))
      .map((signet) => signet.id);
  const groups = new Map<string, MapOwner>();
  for (const group of overview.integrationOwners) {
    const { id: _id, name, membershipId: _membershipId, ...owner } = group;
    groups.set(ownerKey(owner), { key: ownerKey(owner), name, owner, integrations: [] });
  }
  for (const integration of live) {
    const owner = ownerRefSchema.parse(integration);
    const key = ownerKey(owner);
    if (!groups.has(key)) groups.set(key, { key, name: key, owner, integrations: [] });
    groups.get(key)?.integrations.push({
      id: integration.id,
      name: integration.name,
      provider: integration.provider,
      enabled: integration.enabled,
      manages: overview.managedIntegrationIds.includes(integration.id),
      held: heldOn(integration.id),
      resources: overview.resources
        .filter((resource) => resource.integrationId === integration.id && resource.enabled)
        .map(({ id, name, kind }) => ({ id, name, kind })),
    });
  }
  return [...groups.values()];
}

/** The map as routing reads it: one entry per integration, with a held Signet when there is one. */
export const reachableFromMap = (owners: readonly MapOwner[]): Reachable[] =>
  owners.flatMap((group) =>
    group.integrations
      .filter((integration) => integration.enabled)
      .map((integration) => ({
        integrationId: integration.id,
        provider: integration.provider,
        owner: group.owner,
        name: integration.name,
        ...(integration.held[0] ? { signetId: integration.held[0] } : {}),
      })),
  );

/** Compact text: one line per owner, then one indented line per integration. */
export function formatMap(owners: readonly MapOwner[]) {
  const lines: string[] = [];
  for (const group of owners) {
    lines.push(`${group.name}  ${group.key}`);
    if (!group.integrations.length) lines.push('  (no integrations)');
    for (const integration of group.integrations) {
      const flags = [
        integration.enabled ? null : 'disabled',
        integration.manages ? 'manage' : null,
        integration.held.length ? `held ${integration.held.join(',')}` : null,
      ].filter(Boolean);
      lines.push(
        `  ${integration.provider ?? '-'}  ${integration.name}  -i ${integration.id}${flags.length ? `  [${flags.join('; ')}]` : ''}`,
      );
    }
  }
  return lines.join('\n');
}
