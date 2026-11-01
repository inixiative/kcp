import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { kingdomUrl, readPrivateJson, writePrivateJson } from '@inixiative/signet';
import { z } from 'zod';

/** Hosted production Kingdom API origin. */
export const HOSTED_KINGDOM_URL = 'https://api.kingdom.inixiative.com';

/** KCP's private directory: KCP_HOME, else ~/.kcp. One subdirectory per Kingdom host. */
export const kcpHome = (env: Record<string, string | undefined> = process.env) =>
  resolve(env.KCP_HOME ?? join(homedir(), '.kcp'));

const settingsSchema = z.object({ url: z.string().transform(kingdomUrl) }).strict();
const settingsFile = (home: string) => join(home, 'settings.json');

/** The Kingdom the last login used, so later commands need no --url. */
export async function savedKingdomUrl(home: string): Promise<string | undefined> {
  const value = await readPrivateJson(settingsFile(home)).catch(() => undefined);
  const parsed = settingsSchema.safeParse(value);
  return parsed.success ? parsed.data.url : undefined;
}

export const saveKingdomUrl = (home: string, url: string) =>
  writePrivateJson(settingsFile(home), { url: kingdomUrl(url) });

/** --url, then KINGDOM_URL, then the Kingdom last logged in to, then hosted production. */
export const defaultKingdomUrl = (
  flag: string | undefined,
  saved: string | undefined,
  env: Record<string, string | undefined> = process.env,
) => kingdomUrl(flag ?? env.KINGDOM_URL ?? saved ?? HOSTED_KINGDOM_URL);
