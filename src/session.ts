import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  awaitSignet,
  defaultInstallationName,
  type HolderView,
  heldCredentials,
  heldSignetFile,
  holdInstallationSignets,
  holdPersonSignets,
  installationDirectory,
  installationPaths,
  installationSignets,
  kingdomUrl,
  pairInstallation,
  privateDirectory,
  readPrivateJson,
  requestSignet,
  SignetHolders,
  saveCollectedSignet,
  signetCredentialFile,
  signetCredentialSchema,
  withdrawRegistration,
  withHoldLock,
  writePrivateJson,
} from '@inixiative/signet';
import {
  type InstallationKind,
  installationKindSchema,
  type OwnerRef,
  ownerKey,
  ownerRefSchema,
} from '@inixiative/signet/contracts';
import { z } from 'zod';
import { saveKingdomUrl } from './kingdom';
import {
  enrollableSignets,
  integrationFamily,
  type OverviewSignet,
  readOverview,
  signetIntegrationIds,
} from './overview';
import type { ProviderFamily } from './selectors';

/** The installation kind a KCP pairs as. Kingdom and `@inixiative/signet` don't declare it yet. */
export const kcpInstallationKind = 'kcp';

/** `kcp` as an installation kind, once `@inixiative/signet` declares it; null until then. */
export const supportedInstallationKind = (): InstallationKind | null => {
  const parsed = installationKindSchema.safeParse(kcpInstallationKind);
  return parsed.success ? parsed.data : null;
};

const installationName = (name: string | undefined) => name ?? defaultInstallationName('KCP');

/** What a paired KCP keeps beside its key: the integration Kingdom made for it. */
export const pairedInstallationSchema = z
  .object({ integrationId: z.uuid(), signetId: z.uuid(), owner: ownerRefSchema })
  .strict();
const pairedFile = (directory: string) => join(directory, 'installation.json');

export async function pairedInstallation(home: string, url: string) {
  const parsed = pairedInstallationSchema.safeParse(
    await readPrivateJson(pairedFile(installationPaths(home, url).directory)).catch(() => null),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Enrolls this key on every Signet Kingdom lists for the paired installation's integration (later
 * grants arrive this way). Does nothing for a KCP that isn't paired.
 */
export async function holdGrantedSignets(home: string, url: string) {
  if (!(await pairedInstallation(home, url))) return [];
  const { keyFile, directory } = await installationDirectory(home, url);
  const { signets } = await installationSignets(url, keyFile, { timeoutMs: 10_000 });
  return holdInstallationSignets(url, keyFile, directory, signets);
}

export type Review = { reviewCode: string; review: string; expiresAt: string };

/**
 * `kcp login`: pairs this machine as a KCP installation. A person approves it in Kingdom as an
 * owner; the owner's KCP integration then holds whatever Signets the owner grants it.
 */
export async function pairKcp(input: {
  home: string;
  url: string;
  name?: string;
  organization?: string;
  onReview: (review: Review) => void;
  onWaiting?: (message: string) => void;
  signal?: AbortSignal;
}) {
  const kind = supportedInstallationKind();
  if (!kind)
    throw Error(
      `Kingdom can't pair a KCP yet: the '${kcpInstallationKind}' installation kind isn't declared (@inixiative/signet and Kingdom). Log in with --token or --signet instead.`,
    );
  const url = kingdomUrl(input.url);
  await privateDirectory(input.home);
  const name = installationName(input.name);
  const paired = await pairInstallation({
    url,
    root: input.home,
    kind,
    name,
    terms: {
      name,
      lifecycle: 'ongoing',
      ...(input.organization
        ? { owner: { ownerModel: 'Organization', organization: input.organization } }
        : {}),
      resources: [],
      expiresAt: null,
      maxRequests: null,
    },
    onReview: input.onReview,
    onError: (error) =>
      input.onWaiting?.(error instanceof Error ? error.message : 'Kingdom did not answer'),
    confirmOwner: async ({ owner }) => owner !== null,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  await writePrivateJson(pairedFile(paired.directory), {
    integrationId: paired.integrationId,
    signetId: paired.signetId,
    owner: paired.owner,
  });
  await saveKingdomUrl(input.home, url);
  const held = await holdGrantedSignets(input.home, url);
  return {
    url,
    integrationId: paired.integrationId,
    owner: paired.owner,
    ownerName: paired.ownerName,
    signetIds: held.map((signet) => signet.signetId),
  };
}

/**
 * A Signet `kcp login --token` would enroll, as the person is asked to confirm it, with the
 * integrations it reaches whose provider family KCP serves.
 */
export type EnrollCandidate = {
  signetId: string;
  name: string;
  integrations: { integrationId: string; family: ProviderFamily }[];
};

/**
 * `kcp login --token`: acts as the person a Kingdom API token belongs to. With `signetId` it
 * enrolls this key on that one Signet. Without, it offers the Signets issued to the person (or
 * their memberships) on integrations whose provider family KCP serves and not held here yet, and
 * enrolls them only once `confirm` agrees. With `request` it asks for a Signet on an integration
 * and waits for the owner. Every write goes through signet's hold lock; the token is used, never
 * stored.
 */
export async function loginWithToken(input: {
  home: string;
  url: string;
  apiToken: string;
  signetId?: string;
  request?: { integrationId: string; operations: string[] };
  confirm?: (candidates: readonly EnrollCandidate[]) => Promise<boolean>;
  name?: string;
  onReview?: (review: { reviewCode: string; expiresAt: string }) => void;
  signal?: AbortSignal;
}) {
  const url = kingdomUrl(input.url);
  await privateDirectory(input.home);
  const { keyFile, directory } = await installationDirectory(input.home, url);
  const overview = await readOverview(url, input.apiToken);
  const name = installationName(input.name);
  const ownerOf = (integrationId: string): OwnerRef | undefined => {
    const integration = overview.integrations.find((item) => item.id === integrationId);
    return integration ? ownerRefSchema.parse(integration) : undefined;
  };
  /** The owner of every integration the Signet reaches, when they share one; else none is recorded. */
  const signetOwner = (signet: OverviewSignet): OwnerRef | undefined => {
    const owners = signetIntegrationIds(overview, signet).map(ownerOf);
    const [first] = owners;
    return first && owners.every((owner) => owner && ownerKey(owner) === ownerKey(first))
      ? first
      : undefined;
  };
  if (input.request) {
    const { integrationId, operations } = input.request;
    const resources = overview.resources.filter(
      (resource) => resource.integrationId === integrationId && resource.enabled,
    );
    if (!resources.length)
      throw Error(`Kingdom shows you no resources on integration ${integrationId} to ask for`);
    const requested = await requestSignet(url, keyFile, input.apiToken, {
      name,
      lifecycle: 'ongoing',
      expiresAt: null,
      maxRequests: null,
      resources: resources.map((resource) => ({
        resourceModel: 'IntegrationResource' as const,
        integrationResourceId: resource.id,
        operations: { picks: operations },
      })),
    });
    input.onReview?.({ reviewCode: requested.reviewCode, expiresAt: requested.expiresAt });
    const collected = await awaitSignet(url, keyFile, requested.requestId, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await withHoldLock(directory, () =>
      saveCollectedSignet(
        signetCredentialFile(directory, collected.signetId),
        url,
        keyFile,
        collected,
      ),
    );
    await saveKingdomUrl(input.home, url);
    return { url, signetIds: [collected.signetId] };
  }
  const enrollable = enrollableSignets(overview);
  let chosen: typeof enrollable;
  if (input.signetId) {
    chosen = enrollable.filter((signet) => signet.id === input.signetId);
    if (!chosen.length)
      throw Error(`Signet ${input.signetId} isn't issued to you, or is revoked, closed or expired`);
  } else {
    const held = new Set((await heldCredentials(directory)).map((item) => item.signetId));
    const candidates = enrollable.flatMap((signet): EnrollCandidate[] => {
      const integrations = signetIntegrationIds(overview, signet).flatMap((integrationId) => {
        const family = integrationFamily(overview, integrationId);
        return family ? [{ integrationId, family }] : [];
      });
      return integrations.length && !held.has(signet.id)
        ? [{ signetId: signet.id, name: signet.name, integrations }]
        : [];
    });
    if (!candidates.length) {
      await saveKingdomUrl(input.home, url);
      return { url, signetIds: [] };
    }
    if (!input.confirm || !(await input.confirm(candidates)))
      throw Error(
        'Nothing enrolled: confirm the Signets listed (--yes when not interactive), or name one with --signet',
      );
    const ids = new Set(candidates.map((candidate) => candidate.signetId));
    chosen = enrollable.filter((signet) => ids.has(signet.id));
  }
  const enrolled = await holdPersonSignets(
    url,
    keyFile,
    directory,
    input.apiToken,
    chosen.map((signet) => {
      const owner = signetOwner(signet);
      return {
        signetId: signet.id,
        expectedRevision: signet.currentRevision,
        ...(owner ? { owner } : {}),
      };
    }),
    { name, replace: Boolean(input.signetId) },
  );
  await saveKingdomUrl(input.home, url);
  return { url, signetIds: enrolled.flatMap((item) => (item.enrolled ? [item.signetId] : [])) };
}

const uuid = z.uuid();

/**
 * `kcp login --signet <file|id>`: a credential file is copied in as it is (its key stays where it
 * is); an id is enrolled through the paired installation, or with `apiToken` as its person.
 */
export async function loginWithSignet(input: {
  home: string;
  url: string;
  signet: string;
  apiToken?: string;
  name?: string;
}) {
  if (uuid.safeParse(input.signet).success) {
    if (input.apiToken)
      return loginWithToken({
        home: input.home,
        url: input.url,
        apiToken: input.apiToken,
        signetId: input.signet,
        ...(input.name ? { name: input.name } : {}),
      });
    if (!(await pairedInstallation(input.home, input.url)))
      throw Error(
        'Enrolling a Signet by id needs this machine paired (kcp login) or --token for the person it was issued to',
      );
    await heldSignetFile(input.home, input.url, input.signet);
    await saveKingdomUrl(input.home, input.url);
    return { url: kingdomUrl(input.url), signetIds: [input.signet] };
  }
  const credential = signetCredentialSchema.parse(await readPrivateJson(input.signet));
  if (!existsSync(credential.keyFile))
    throw Error(`The Signet's key file ${credential.keyFile} is missing`);
  const { directory } = installationPaths(input.home, credential.url);
  await privateDirectory(input.home);
  await privateDirectory(directory);
  const target = signetCredentialFile(directory, credential.signetId);
  await writePrivateJson(target, credential);
  await saveKingdomUrl(input.home, credential.url);
  return { url: credential.url, signetIds: [credential.signetId] };
}

/**
 * `kcp logout`: withdraws an open pairing and deletes this machine's key and Signets for one
 * Kingdom. Revoking them stays with Kingdom, so it returns what the owner should revoke there; a
 * withdrawal Kingdom refused is reported, and the local files go regardless.
 */
export async function logout(home: string, url: string) {
  const origin = kingdomUrl(url);
  const { directory } = installationPaths(home, origin);
  const held = await heldCredentials(directory);
  const paired = await pairedInstallation(home, origin);
  const withdrawal = await withdrawRegistration(home, origin).then(
    (ids) => ({ ids, error: null }),
    (error: unknown) => ({
      ids: [] as string[],
      error: error instanceof Error ? error.message : 'Kingdom did not answer',
    }),
  );
  await rm(directory, { recursive: true, force: true });
  const signetIds = [
    ...new Set([
      ...held.map((credential) => credential.signetId),
      ...(paired ? [paired.signetId] : []),
    ]),
  ];
  return {
    url: origin,
    removedSignetIds: held.map((credential) => credential.signetId),
    withdrawnRegistrations: withdrawal.ids,
    ...(withdrawal.error ? { withdrawError: withdrawal.error } : {}),
    revokeInKingdom: {
      signetIds,
      ...(paired ? { integrationId: paired.integrationId } : {}),
    },
  };
}

export type HeldStatus = {
  signetId: string;
  /** The integrations its resources sit on, as Kingdom describes them now; empty when unread. */
  integrations: { integrationId: string; provider: string }[];
  owner: OwnerRef | null;
  status: HolderView['status'];
  renewalExpiresAt: string;
};

/** `kcp status`: the paired installation, and each held Signet as Kingdom describes it now. */
export async function status(home: string, url: string, holders = new SignetHolders()) {
  const origin = kingdomUrl(url);
  const { directory } = installationPaths(home, origin);
  const paired = await pairedInstallation(home, origin);
  const holdError = await holdGrantedSignets(home, origin).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : 'Kingdom did not answer'),
  );
  const held = await heldCredentials(directory);
  const signets: HeldStatus[] = await Promise.all(
    held.map(async (credential) => {
      const view = await holders.get(
        { url: origin, signetId: credential.signetId, credentialFile: credential.credentialFile },
        10_000,
      );
      return {
        signetId: credential.signetId,
        integrations: [
          ...new Map(
            (view.description?.operations ?? [])
              .flatMap((operation) => operation.resources)
              .map(({ integrationId, provider }) => [integrationId, { integrationId, provider }]),
          ).values(),
        ],
        owner: credential.owner ?? null,
        status: view.status,
        renewalExpiresAt: credential.renewalExpiresAt,
      };
    }),
  );
  return {
    url: origin,
    loggedIn: signets.length > 0 || paired !== null,
    installation: paired,
    pairingSupported: supportedInstallationKind() !== null,
    ...(holdError ? { syncError: holdError } : {}),
    signets,
  };
}
