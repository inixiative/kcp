import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  cancelInstallationInquiry,
  holdInstallationSignets,
  installationDirectory,
  installationInquiries,
  installationSignets,
  kingdomUrl,
  readPrivateJson,
  type SignetCredential,
  signetCredentialFile,
  signetCredentialSchema,
} from '@inixiative/signet';

/**
 * Where the Installation for one Kingdom lives under `root`, without creating anything. Mirrors
 * `installationDirectory` from `@inixiative/signet`.
 */
export function installationPaths(root: string, url: string) {
  const directory = join(resolve(root), new URL(kingdomUrl(url)).host);
  return { directory, keyFile: join(directory, 'installation-key.json') };
}

/** Creates `path` as a 0700 directory owned by this user, or makes an existing one so. */
export async function privateDirectory(path: string) {
  const directory = resolve(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error(`${directory} must be a directory owned by this user`);
  await chmod(directory, 0o700);
}

/** Which Signets each Kingdom lists for this Installation: one read per Kingdom; null when it refused or is unreachable. */
export async function listedSignets(root: string, urls: readonly string[]) {
  const listed = new Map<string, Set<string> | null>();
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      const { keyFile } = installationPaths(root, url);
      try {
        if (!existsSync(keyFile)) throw Error('No Installation key');
        const { signets } = await installationSignets(url, keyFile, { timeoutMs: 5000 });
        listed.set(url, new Set(signets.map((signet) => signet.signetId)));
      } catch {
        listed.set(url, null);
      }
    }),
  );
  return listed;
}

/** The local file of a Signet this Installation holds, enrolling it now if Kingdom lists it but no file exists yet. */
export async function heldSignetFile(root: string, url: string, signetId: string) {
  const { keyFile, directory } = await installationDirectory(root, url);
  const file = signetCredentialFile(directory, signetId);
  if (existsSync(file)) return file;
  const listed = (await installationSignets(url, keyFile)).signets.filter(
    (signet) => signet.signetId === signetId,
  );
  if (!listed.length) throw Error(`Kingdom does not list Signet ${signetId} for this installation`);
  await holdInstallationSignets(url, keyFile, directory, listed);
  if (!existsSync(file)) throw Error(`Signet ${signetId} could not be enrolled here`);
  return file;
}

/**
 * Withdraws every open registration of this Installation, so a later approval in Kingdom mints no
 * integration nothing collects. One pairing runs at a time per installation, so every open
 * registration belongs to a pairing that no longer waits.
 */
export async function withdrawRegistration(root: string, url: string) {
  const { keyFile } = installationPaths(root, url);
  if (!existsSync(keyFile)) return [];
  const { inquiries } = await installationInquiries(kingdomUrl(url), keyFile);
  const open = inquiries.filter(
    (inquiry) =>
      inquiry.type === 'registerIntegration' &&
      (inquiry.status === 'sent' || inquiry.status === 'changesRequested'),
  );
  for (const inquiry of open) await cancelInstallationInquiry(kingdomUrl(url), keyFile, inquiry.id);
  return open.map((inquiry) => inquiry.id);
}

export type HeldCredential = SignetCredential & { credentialFile: string };

/** Every Signet credential file in one Kingdom's directory that parses; others are skipped. */
export async function heldCredentials(directory: string): Promise<HeldCredential[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const held = await Promise.all(
    names
      .filter((name) => /^signet-[0-9a-f-]{36}\.json$/.test(name))
      .map(async (name) => {
        const credentialFile = join(directory, name);
        const parsed = signetCredentialSchema.safeParse(
          await readPrivateJson(credentialFile).catch(() => null),
        );
        return parsed.success ? [{ ...parsed.data, credentialFile }] : [];
      }),
  );
  return held.flat();
}
