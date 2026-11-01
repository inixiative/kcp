import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  type ProviderFamily,
  providerFamilySchema,
  type Selection,
  selectionFromIds,
} from './selectors';

/**
 * One provider's mapping in a repo's `.foundry/kcp.json`: the same ids the selector flags take,
 * `integrationId` for one integration or owner ids for whichever of that owner's integrations
 * routing then finds.
 */
export const projectRouteSchema = z
  .strictObject({
    integrationId: z.uuid().optional(),
    organizationId: z.uuid().optional(),
    spaceId: z.uuid().optional(),
    userId: z.uuid().optional(),
  })
  .refine((route) => Object.keys(route).length > 0, 'Name an integration or an owner');

/** `.foundry/kcp.json`, committed: which integration each CLI uses in this repo. */
export const kcpProjectSchema = z.strictObject({
  providers: z.partialRecord(providerFamilySchema, projectRouteSchema),
});
export type KcpProject = z.infer<typeof kcpProjectSchema>;

export const projectFileName = join('.foundry', 'kcp.json');

/**
 * The nearest `.foundry/kcp.json` from `cwd` up to its repo root (the first directory with `.git`).
 * Outside a repo there is none: a walk that reaches `home` or the filesystem root without finding
 * `.git` returns null, so a stray mapping above the repo, or anywhere above `home`, is never read.
 */
export function findProjectFile(cwd: string, home: string = homedir()): string | null {
  const stop = resolve(home);
  let found: string | null = null;
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const file = join(directory, projectFileName);
    if (!found && existsSync(file)) found = file;
    if (existsSync(join(directory, '.git'))) return found;
    if (directory === stop || dirname(directory) === directory) return null;
  }
}

export async function readProject(file: string): Promise<KcpProject> {
  const parsed = kcpProjectSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success)
    throw Error(
      `${file} is not a KCP project mapping: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  return parsed.data;
}

/** The project's mapping as the Selection its flags would make. */
export function projectSelections(project: KcpProject) {
  const selections: Partial<Record<ProviderFamily, Selection>> = {};
  for (const family of providerFamilySchema.options) {
    const route = project.providers[family];
    if (route) selections[family] = selectionFromIds(route);
  }
  return selections;
}
