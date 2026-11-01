import { type OwnerRef, ownerKey } from '@inixiative/signet/contracts';
import { ownerMatches } from './owner';
import type { OwnerSelector, ProviderFamily, Selection } from './selectors';

/** An integration this machine can see, and the Signet it holds on it, if any. */
export type Reachable = {
  integrationId: string;
  /** Kingdom's provider name; a provider family is named the same. */
  provider: string | null;
  /** The integration's owner; null when this machine doesn't know it. */
  owner: OwnerRef | null;
  name?: string;
  signetId?: string;
};

export type RouteVia = 'signet' | 'integration' | 'owner' | 'project' | 'single';

export type Route =
  /** One integration, and every Signet held on it; `chooseSignet` picks one once the command is parsed. */
  | { status: 'resolved'; via: RouteVia; integrationId: string; signetIds: string[] }
  /** Nothing this machine holds reaches it: ask the owner for a Signet (§5.6). */
  | {
      status: 'ask';
      family: ProviderFamily;
      reason: string;
      integrationId?: string;
      owner?: OwnerSelector;
    }
  /** Several integrations match (name one with `-i`), or several Signets on one (name one with `--signet`). */
  | {
      status: 'ambiguous';
      family: ProviderFamily;
      choose: 'integration' | 'signet';
      candidates: Reachable[];
      reason: string;
    }
  | { status: 'error'; reason: string };

export type RouteInput = {
  family: ProviderFamily;
  selection: Selection;
  /** The repo's `.foundry/kcp.json` mapping for this family, as a Selection. */
  project?: Selection;
  reachable: readonly Reachable[];
};

const describeOwner = (owner: OwnerSelector) => ownerKey(owner);

function byIntegration(input: RouteInput, integrationId: string, via: RouteVia): Route {
  const on = input.reachable.filter((item) => item.integrationId === integrationId);
  const other = on.find((item) => item.provider !== input.family);
  if (other)
    return {
      status: 'error',
      reason: `Integration ${integrationId} is ${other.provider ?? 'not a provider integration'}, not ${input.family}`,
    };
  const signetIds = [...new Set(on.flatMap((item) => (item.signetId ? [item.signetId] : [])))];
  if (!signetIds.length)
    return {
      status: 'ask',
      family: input.family,
      integrationId,
      reason: `This machine holds no Signet on integration ${integrationId}`,
    };
  return { status: 'resolved', via, integrationId, signetIds: signetIds.sort() };
}

/** One candidate per integration: several Signets on one integration are one match, not several. */
const perIntegration = (items: readonly Reachable[]) => [
  ...new Map(items.map((item) => [item.integrationId, item])).values(),
];

function byMatches(
  input: RouteInput,
  matches: readonly Reachable[],
  via: RouteVia,
  owner?: OwnerSelector,
): Route {
  const where = owner ? ` for ${describeOwner(owner)}` : '';
  const integrations = perIntegration(matches);
  if (integrations.length > 1)
    return {
      status: 'ambiguous',
      family: input.family,
      choose: 'integration',
      candidates: integrations,
      reason: `${integrations.length} ${input.family} integrations match${where}; choose one with -i`,
    };
  const [only] = integrations;
  if (!only)
    return {
      status: 'ask',
      family: input.family,
      ...(owner ? { owner } : {}),
      reason: `No ${input.family} integration is reachable${where}`,
    };
  return byIntegration(input, only.integrationId, via);
}

const ofFamily = (input: RouteInput) =>
  input.reachable.filter((item) => item.provider === input.family);

function bySelection(input: RouteInput, selection: Selection, via: 'project' | null): Route | null {
  if (selection.integrationId)
    return byIntegration(input, selection.integrationId, via ?? 'integration');
  if (selection.owner) {
    const owner = selection.owner;
    return byMatches(
      input,
      ofFamily(input).filter((item) => item.owner !== null && ownerMatches(owner, item.owner)),
      via ?? 'owner',
      owner,
    );
  }
  return null;
}

/**
 * The owner flags beside an exact choice (`--signet`, `-i`) must name the owner of what it
 * chose; flags that disagree, or an owner this machine can't check, are refused, never overridden.
 */
function ownerContradiction(
  owner: OwnerSelector | undefined,
  chosen: readonly Reachable[],
  flag: string,
): Route | null {
  if (!owner) return null;
  const known = chosen.find((item) => item.owner !== null)?.owner;
  if (!known)
    return {
      status: 'error',
      reason: `Can't check ${flag} against the owner flags (${describeOwner(owner)}): this machine doesn't know its owner. Pass ${flag} or the owner flags, not both`,
    };
  if (!ownerMatches(owner, known))
    return {
      status: 'error',
      reason: `${flag} belongs to ${ownerKey(known)}, not ${describeOwner(owner)}; pass one or the other`,
    };
  return null;
}

/**
 * Which integration a command runs through (OPERATOR-ACCESS §5): an exact Signet, then `-i`, then
 * the owner flags, then the repo's mapping, then the one matching integration; when nothing
 * resolves, the owner is asked. Flags that contradict each other are refused.
 */
export function resolveRoute(input: RouteInput): Route {
  const { selection } = input;
  if (selection.signetId) {
    const held = input.reachable.find((item) => item.signetId === selection.signetId);
    if (!held)
      return {
        status: 'error',
        reason: `This machine holds no Signet ${selection.signetId}; kcp login --signet ${selection.signetId}`,
      };
    if (selection.integrationId && selection.integrationId !== held.integrationId)
      return {
        status: 'error',
        reason: `Signet ${selection.signetId} is on integration ${held.integrationId}, not -i ${selection.integrationId}`,
      };
    const contradiction = ownerContradiction(selection.owner, [held], '--signet');
    if (contradiction) return contradiction;
    if (held.provider !== input.family)
      return {
        status: 'error',
        reason: `Signet ${selection.signetId} is on a ${held.provider ?? 'non-provider'} integration, not ${input.family}`,
      };
    return {
      status: 'resolved',
      via: 'signet',
      integrationId: held.integrationId,
      signetIds: [selection.signetId],
    };
  }
  if (selection.integrationId) {
    const integrationId = selection.integrationId;
    const contradiction = ownerContradiction(
      selection.owner,
      input.reachable.filter((item) => item.integrationId === integrationId),
      '-i',
    );
    if (contradiction) return contradiction;
  }
  const flagged = bySelection(input, selection, null);
  if (flagged) return flagged;
  const mapped = input.project ? bySelection(input, input.project, 'project') : null;
  if (mapped) return mapped;
  return byMatches(input, ofFamily(input), 'single');
}

/** What one held Signet grants: each operation and the resources it reaches. */
export type SignetGrants = {
  signetId: string;
  grants: readonly { operation: string; resourceIds: readonly string[] }[];
};

/**
 * The Signet a parsed command runs through, among those held on the routed integration: the only
 * one, else one that grants the operation on the resource. Several held, none granting it: the
 * person names one with `--signet`.
 */
export function chooseSignet<Candidate extends SignetGrants & Reachable>(
  candidates: readonly Candidate[],
  parsed: { operation: string; resourceId: string },
  family: ProviderFamily,
): { status: 'chosen'; signet: Candidate } | Extract<Route, { status: 'ambiguous' }> {
  const [only] = candidates;
  if (only && candidates.length === 1) return { status: 'chosen', signet: only };
  const granting = candidates.filter((candidate) =>
    candidate.grants.some(
      (grant) =>
        grant.operation === parsed.operation && grant.resourceIds.includes(parsed.resourceId),
    ),
  );
  const [first] = granting;
  if (first) return { status: 'chosen', signet: first };
  return {
    status: 'ambiguous',
    family,
    choose: 'signet',
    candidates: [...candidates],
    reason: `${candidates.length} Signets are held on this integration and none grants ${parsed.operation} on resource ${parsed.resourceId}; choose one with --signet`,
  };
}
