import type { OwnerRef } from '@inixiative/signet/contracts';
import { z } from 'zod';

/** The CLIs KCP proxies, by the provider family whose integration runs them. */
export const providerFamilySchema = z.enum(['railway', 'github', 'vercel', 'infisical']);
export type ProviderFamily = z.infer<typeof providerFamilySchema>;

const binaryFamilies: Record<string, ProviderFamily> = {
  railway: 'railway',
  gh: 'github',
  git: 'github',
  vercel: 'vercel',
  infisical: 'infisical',
};

export const providerFamilyOf = (binary: string): ProviderFamily | null =>
  Object.hasOwn(binaryFamilies, binary) ? (binaryFamilies[binary] ?? null) : null;

/**
 * An owner named by flags. Ids the flags didn't give stay absent, so a `-s` alone matches a Space
 * in whichever organization holds it.
 */
export type OwnerSelector = Pick<OwnerRef, 'ownerModel'> &
  Partial<Pick<OwnerRef, 'userId' | 'organizationId' | 'spaceId'>>;

/** Where a command should run, as the flags name it, before routing looks at what exists. */
export type Selection = {
  signetId?: string;
  tokenId?: string;
  integrationId?: string;
  owner?: OwnerSelector;
};

export type ParsedCommand = {
  selection: Selection;
  binary: string;
  family: ProviderFamily;
  args: string[];
};

export class SelectorError extends Error {}

const uuid = z.uuid();
const flagKeys = {
  '-i': 'integrationId',
  '-o': 'organizationId',
  '-s': 'spaceId',
  '-u': 'userId',
  '--signet': 'signetId',
  '--token': 'tokenId',
} as const;
type SelectorFlag = keyof typeof flagKeys;
type FlagKey = (typeof flagKeys)[SelectorFlag];
export type SelectorIds = Partial<Record<FlagKey, string>>;

/**
 * The owner the id flags name: `-o` with `-u` is the membership, `-s` with `-u` the space
 * membership; `-o` alongside `-s` only says which organization the space is in.
 */
export function ownerFromIds(
  ids: Pick<SelectorIds, 'organizationId' | 'spaceId' | 'userId'>,
): OwnerSelector | undefined {
  const { organizationId, spaceId, userId } = ids;
  const ownerModel = spaceId
    ? userId
      ? 'SpaceUser'
      : 'Space'
    : organizationId
      ? userId
        ? 'OrganizationUser'
        : 'Organization'
      : userId
        ? 'User'
        : null;
  if (!ownerModel) return undefined;
  return {
    ownerModel,
    ...(userId ? { userId } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(spaceId ? { spaceId } : {}),
  };
}

/** A Selection from validated ids; `--signet` and `--token` each name one exact grant, so not both. */
export function selectionFromIds(ids: SelectorIds): Selection {
  for (const [key, value] of Object.entries(ids))
    if (value !== undefined && !uuid.safeParse(value).success)
      throw new SelectorError(`${flagFor(key)} takes a UUID, not ${JSON.stringify(value)}`);
  if (ids.signetId && ids.tokenId)
    throw new SelectorError('--signet and --token each choose one exact grant; pass one');
  const owner = ownerFromIds(ids);
  return {
    ...(ids.signetId ? { signetId: ids.signetId } : {}),
    ...(ids.tokenId ? { tokenId: ids.tokenId } : {}),
    ...(ids.integrationId ? { integrationId: ids.integrationId } : {}),
    ...(owner ? { owner } : {}),
  };
}

const flagFor = (key: string) =>
  Object.entries(flagKeys).find(([, value]) => value === key)?.[0] ?? key;

/**
 * `kcp [selectors] <cli> <args…>`: selector flags come first; the first other word is the CLI, and
 * everything after it is that CLI's, untouched.
 */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const ids: SelectorIds = {};
  let index = 0;
  for (let word = argv[0]; word !== undefined; word = argv[++index]) {
    const [flag, inline] = word.startsWith('--') ? word.split(/=(.*)/s) : [word];
    const key = flag && Object.hasOwn(flagKeys, flag) ? flagKeys[flag as SelectorFlag] : null;
    if (!flag || !key) {
      if (word.startsWith('-')) throw new SelectorError(`Unknown selector ${word}`);
      break;
    }
    const value = inline ?? argv[++index];
    if (value === undefined || (inline === undefined && value.startsWith('-')))
      throw new SelectorError(`${flag} needs an id`);
    if (ids[key] !== undefined && ids[key] !== value)
      throw new SelectorError(`${flag} was given twice with different ids`);
    ids[key] = value;
  }
  const binary = argv[index];
  if (!binary) throw new SelectorError('Name the CLI to run, for example: kcp railway logs');
  const family = providerFamilyOf(binary);
  if (!family)
    throw new SelectorError(
      `KCP does not proxy ${binary}; it runs ${Object.keys(binaryFamilies).join(', ')}`,
    );
  return { selection: selectionFromIds(ids), binary, family, args: argv.slice(index + 1) };
}
