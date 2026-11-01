import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

/** The nearest `.foundry/kcp.json` from `cwd` up to the repo root (the first directory with `.git`). */
export function findProjectFile(cwd: string): string | null {
  for (let directory = cwd; ; directory = dirname(directory)) {
    const file = join(directory, projectFileName);
    if (existsSync(file)) return file;
    if (existsSync(join(directory, '.git')) || dirname(directory) === directory) return null;
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
