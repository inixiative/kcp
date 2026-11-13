import type { OwnerRef } from '@inixiative/signet/contracts';
import { z } from 'zod';

/** The CLIs KCP proxies, by the provider family whose integration runs them. */
export const providerFamilySchema = z.enum(['railway', 'github', 'vercel', 'infisical']);
export type ProviderFamily = z.infer<typeof providerFamilySchema>;

const binaryFamilies: Record<string, ProviderFamily> = {
  railway: 'railway',
  gh: 'github',
  vercel: 'vercel',
  infisical: 'infisical',
};

/**
 * `git push` and `git fetch` read the local working tree, so they run on this machine with a
 * short-lived credential from KCP's git credential helper (OPERATOR-ACCESS §4), never as a Kingdom
 * `execute`.
 */
export const gitRefusal =
  "KCP doesn't run git through Kingdom: git reads your working tree, so it runs locally with a short-lived credential from KCP's git credential helper (OPERATOR-ACCESS §4), which isn't built yet";

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

/** A Selection from validated ids. */
export function selectionFromIds(ids: SelectorIds): Selection {
  for (const [key, value] of Object.entries(ids))
    if (value !== undefined && !uuid.safeParse(value).success)
      throw new SelectorError(`${flagFor(key)} takes a UUID, not ${JSON.stringify(value)}`);
  const owner = ownerFromIds(ids);
  return {
    ...(ids.signetId ? { signetId: ids.signetId } : {}),
    ...(ids.integrationId ? { integrationId: ids.integrationId } : {}),
    ...(owner ? { owner } : {}),
  };
}

const flagFor = (key: string) =>
  Object.entries(flagKeys).find(([, value]) => value === key)?.[0] ?? key;

/**
 * The selector flags at the start of a command line, and everything from the first other word on,
 * untouched: a CLI's name and its arguments, or one of KCP's own commands (`listen`) and its flags.
 */
export function parseSelectors(argv: readonly string[]): { selection: Selection; rest: string[] } {
  const ids: SelectorIds = {};
  let index = 0;
  for (let word = argv[0]; word !== undefined; word = argv[++index]) {
    const [flag, inline] = word.startsWith('--') ? word.split(/=(.*)/s) : [word];
    const key = flag && Object.hasOwn(flagKeys, flag) ? flagKeys[flag as SelectorFlag] : null;
    if (flag === '--token')
      throw new SelectorError(
        "--token is not an integration selector: a Kingdom API token never reaches an integration, only Kingdom's own API (kcp map --token). Choose a grant with --signet",
      );
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
  return { selection: selectionFromIds(ids), rest: argv.slice(index) };
}

/**
 * `kcp [selectors] <cli> <args…>`: selector flags come first; the first other word is the CLI, and
 * everything after it is that CLI's, untouched.
 */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const { selection, rest } = parseSelectors(argv);
  const [binary, ...args] = rest;
  if (!binary) throw new SelectorError('Name the CLI to run, for example: kcp railway logs');
  if (binary === 'git') throw new SelectorError(gitRefusal);
  const family = providerFamilyOf(binary);
  if (!family)
    throw new SelectorError(
      `KCP does not proxy ${binary}; it runs ${Object.keys(binaryFamilies).join(', ')}`,
    );
  return { selection, binary, family, args };
}
