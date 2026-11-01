import type { OwnerRef } from '@inixiative/signet/contracts';
import { ownerKey, ownerMatches } from './owner';
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
  | { status: 'resolved'; via: RouteVia; integrationId: string; signetId: string }
  /** Nothing this machine holds reaches it: ask the owner for a Signet (§5.6). */
  | {
      status: 'ask';
      family: ProviderFamily;
      reason: string;
      integrationId?: string;
      owner?: OwnerSelector;
    }
  /** Several integrations match; name one with `-i`. */
  | { status: 'ambiguous'; family: ProviderFamily; candidates: Reachable[]; reason: string }
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
  const found = input.reachable.find((item) => item.integrationId === integrationId);
  if (found && found.provider !== input.family)
    return {
      status: 'error',
      reason: `Integration ${integrationId} is ${found.provider ?? 'not a provider integration'}, not ${input.family}`,
    };
  if (!found?.signetId)
    return {
      status: 'ask',
      family: input.family,
      integrationId,
      reason: `This machine holds no Signet on integration ${integrationId}`,
    };
  return { status: 'resolved', via, integrationId, signetId: found.signetId };
}

function byMatches(
  input: RouteInput,
  matches: Reachable[],
  via: RouteVia,
  owner?: OwnerSelector,
): Route {
  const where = owner ? ` for ${describeOwner(owner)}` : '';
  if (matches.length > 1)
    return {
      status: 'ambiguous',
      family: input.family,
      candidates: matches,
      reason: `${matches.length} ${input.family} integrations match${where}; choose one with -i`,
    };
  const [only] = matches;
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
 * Which integration and Signet a command runs through (OPERATOR-ACCESS §5): an explicit grant,
 * then `-i`, then the owner flags, then the repo's mapping, then the one matching integration;
 * when nothing resolves, the owner is asked. `-i` overrides the owner flags.
 */
export function resolveRoute(input: RouteInput): Route {
  const { selection } = input;
  if (selection.tokenId)
    return {
      status: 'error',
      reason:
        'A Kingdom API token is not a grant on an integration; Kingdom runs integration operations only through a Signet (--signet)',
    };
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
    if (held.provider !== input.family)
      return {
        status: 'error',
        reason: `Signet ${selection.signetId} is on a ${held.provider ?? 'non-provider'} integration, not ${input.family}`,
      };
    return {
      status: 'resolved',
      via: 'signet',
      integrationId: held.integrationId,
      signetId: selection.signetId,
    };
  }
  const flagged = bySelection(input, selection, null);
  if (flagged) return flagged;
  const mapped = input.project ? bySelection(input, input.project, 'project') : null;
  if (mapped) return mapped;
  return byMatches(input, ofFamily(input), 'single');
}
