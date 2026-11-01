import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  awaitSignet,
  enrollSignet,
  holdInstallationSignets,
  installationDirectory,
  installationSignets,
  kingdomUrl,
  pairInstallation,
  readPrivateJson,
  requestSignet,
  saveCollectedSignet,
  signetCredentialFile,
  signetCredentialSchema,
  writePrivateJson,
} from '@inixiative/signet';
import {
  type InstallationKind,
  installationKindSchema,
  type OwnerRef,
  ownerRefSchema,
} from '@inixiative/signet/contracts';
import { z } from 'zod';
import { type HolderView, SignetHolders } from './holders';
import {
  heldCredentials,
  heldSignetFile,
  installationPaths,
  privateDirectory,
  withdrawRegistration,
} from './installation';
import { saveKingdomUrl } from './kingdom';
import { enrollableSignets, readOverview } from './overview';

/** The installation kind a KCP pairs as. Kingdom and `@inixiative/signet` don't declare it yet. */
export const kcpInstallationKind = 'kcp';

/** `kcp` as an installation kind, once `@inixiative/signet` declares it; null until then. */
export const supportedInstallationKind = (): InstallationKind | null => {
  const parsed = installationKindSchema.safeParse(kcpInstallationKind);
  return parsed.success ? parsed.data : null;
};

export const defaultInstallationName = () => `KCP on ${hostname()}`.slice(0, 120);

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
  const name = input.name ?? defaultInstallationName();
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
      maxConcurrent: 4,
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
 * `kcp login --token`: acts as the person a Kingdom API token belongs to. Without a request it
 * enrolls this key on every Signet issued to that person (or the one `signetId` names); with one it
 * asks for a Signet on an integration and waits for the owner. The token is used, never stored.
 */
export async function loginWithToken(input: {
  home: string;
  url: string;
  apiToken: string;
  signetId?: string;
  request?: { integrationId: string; operations: string[] };
  name?: string;
  onReview?: (review: { reviewCode: string; expiresAt: string }) => void;
  signal?: AbortSignal;
}) {
  const url = kingdomUrl(input.url);
  await privateDirectory(input.home);
  const { keyFile, directory } = await installationDirectory(input.home, url);
  const overview = await readOverview(url, input.apiToken);
  const name = input.name ?? defaultInstallationName();
  const ownerOf = (integrationId: string): OwnerRef | undefined => {
    const integration = overview.integrations.find((item) => item.id === integrationId);
    return integration ? ownerRefSchema.parse(integration) : undefined;
  };
  const saved: string[] = [];
  if (input.request) {
    const { integrationId, operations } = input.request;
    const resources = overview.resources.filter(
      (resource) => resource.integrationId === integrationId && resource.enabled,
    );
    if (!resources.length)
      throw Error(`Kingdom shows you no resources on integration ${integrationId} to ask for`);
    const requested = await requestSignet(url, keyFile, input.apiToken, {
      name,
      integrationId,
      lifecycle: 'ongoing',
      expiresAt: null,
      maxRequests: null,
      maxConcurrent: 1,
      resources: resources.map((resource) => ({ resourceId: resource.id, operations })),
    });
    input.onReview?.({ reviewCode: requested.reviewCode, expiresAt: requested.expiresAt });
    const collected = await awaitSignet(url, keyFile, requested.requestId, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await saveCollectedSignet(
      signetCredentialFile(directory, collected.signetId),
      url,
      keyFile,
      collected,
    );
    saved.push(collected.signetId);
  } else {
    const enrollable = enrollableSignets(overview).filter(
      (signet) => !input.signetId || signet.id === input.signetId,
    );
    if (input.signetId && !enrollable.length)
      throw Error(`Signet ${input.signetId} isn't issued to you, or is revoked, closed or expired`);
    for (const signet of enrollable) {
      const credentialFile = signetCredentialFile(directory, signet.id);
      if (existsSync(credentialFile) && !input.signetId) continue;
      const enrolled = await enrollSignet(url, keyFile, input.apiToken, {
        signetId: signet.id,
        expectedRevision: signet.currentRevision,
        name,
      });
      const owner = ownerOf(signet.integrationId);
      await saveCollectedSignet(credentialFile, url, keyFile, {
        ...enrolled,
        integrationId: signet.integrationId,
        ...(owner ? { owner } : {}),
      });
      saved.push(signet.id);
    }
  }
  await saveKingdomUrl(input.home, url);
  return { url, signetIds: saved };
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
 * Kingdom. Revoking the Signets and the KCP integration stays with Kingdom.
 */
export async function logout(home: string, url: string) {
  const { directory } = installationPaths(home, url);
  const held = await heldCredentials(directory);
  const withdrawn = await withdrawRegistration(home, url).catch(() => []);
  await rm(directory, { recursive: true, force: true });
  return {
    url: kingdomUrl(url),
    removedSignetIds: held.map((credential) => credential.signetId),
    withdrawnRegistrations: withdrawn,
  };
}

export type HeldStatus = {
  signetId: string;
  integrationId: string | null;
  provider: string | null;
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
        integrationId: view.description?.integrationId ?? credential.integrationId ?? null,
        provider: view.description?.provider ?? null,
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
