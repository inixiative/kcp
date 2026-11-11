import {
  type HolderView,
  heldCredentials,
  installationPaths,
  SignetClient,
  SignetHolders,
} from '@inixiative/signet';
import { accessInputSchema } from '@inixiative/signet/contracts';
import {
  isRefused,
  NoOperationsError,
  type OperationParser,
  type OperationResource,
  operationParsers,
} from './operations';
import { findProjectFile, projectSelections, readProject } from './project';
import {
  chooseSignet,
  type Reachable,
  type Route,
  resolveRoute,
  type SignetGrants,
} from './routing';
import { type ParsedCommand, type ProviderFamily, parseCommand } from './selectors';
import { holdGrantedSignets } from './session';

/** Routing found nothing to run through; the message says what to do next. */
export class RouteError extends Error {
  constructor(readonly route: Exclude<Route, { status: 'resolved' }>) {
    super(routeMessage(route));
  }
}

export function routeMessage(route: Exclude<Route, { status: 'resolved' }>) {
  if (route.status === 'error') return route.reason;
  if (route.status === 'ambiguous')
    return [
      `${route.reason}:`,
      ...route.candidates.map((candidate) =>
        route.choose === 'signet'
          ? `  --signet ${candidate.signetId}`
          : `  -i ${candidate.integrationId}  ${candidate.name ?? ''}${candidate.signetId ? '' : '  (no Signet held)'}`,
      ),
    ].join('\n');
  const target = route.integrationId ? ` on integration ${route.integrationId}` : '';
  return `${route.reason}. Ask the integration's owner to grant this machine a Signet${target} for ${route.family}, then run kcp status.`;
}

export type HeldReach = Reachable &
  SignetGrants & {
    signetId: string;
    credentialFile: string;
    resources: OperationResource[];
  };

/**
 * What this machine's held Signets reach, as Kingdom describes them: one entry per Signet and
 * integration its resources sit on (a Signet has no integration of its own), each with that
 * integration's resources and grants. Revoked or unread Signets are left out.
 */
export async function heldReach(home: string, url: string, holders = new SignetHolders()) {
  const held = await heldCredentials(installationPaths(home, url).directory);
  const views: HolderView[] = await Promise.all(
    held.map((credential) =>
      holders.get(
        { url, signetId: credential.signetId, credentialFile: credential.credentialFile },
        10_000,
      ),
    ),
  );
  return held.flatMap((credential, index): HeldReach[] => {
    const description = views[index]?.description;
    if (!description) return [];
    const integrations = new Map<string, string>();
    for (const operation of description.operations)
      for (const resource of operation.resources)
        integrations.set(resource.integrationId, resource.provider);
    return [...integrations].map(([integrationId, provider]) => {
      const resources = new Map<string, OperationResource>();
      for (const operation of description.operations)
        for (const resource of operation.resources)
          if (resource.integrationId === integrationId)
            resources.set(resource.id, {
              id: resource.id,
              name: resource.name,
              kind: resource.kind,
            });
      return {
        integrationId,
        provider,
        owner: credential.owner ?? null,
        name: description.name,
        signetId: credential.signetId,
        credentialFile: credential.credentialFile,
        resources: [...resources.values()],
        grants: description.operations.map((operation) => ({
          operation: operation.key,
          resourceIds: operation.resources
            .filter((resource) => resource.integrationId === integrationId)
            .map((resource) => resource.id),
        })),
      };
    });
  });
}

async function projectSelection(cwd: string, family: ProviderFamily) {
  const file = findProjectFile(cwd);
  return file ? projectSelections(await readProject(file))[family] : undefined;
}

type Execute = (
  credentialFile: string,
  request: Parameters<SignetClient['execute']>[0],
) => Promise<unknown>;

const executeWithSignet: Execute = async (credentialFile, request) =>
  (await SignetClient.fromFile(credentialFile)).execute(request);

/**
 * `kcp <selectors> <cli> <args…>`: route to an integration, parse the command into a declared
 * operation's typed input, pick the held Signet that grants it, and execute it through that
 * Signet. The argv itself is never sent, and a provider with no parser makes no network call.
 */
export async function runCommand(input: {
  argv: readonly string[];
  home: string;
  url: string;
  cwd: string;
  parsers?: Partial<Record<ProviderFamily, OperationParser>>;
  holders?: SignetHolders;
  execute?: Execute;
}) {
  const command: ParsedCommand = parseCommand(input.argv);
  const parser = (input.parsers ?? operationParsers)[command.family];
  if (!parser) throw new NoOperationsError(command.family);
  await holdGrantedSignets(input.home, input.url).catch(() => []);
  const reach = await heldReach(input.home, input.url, input.holders);
  const project = await projectSelection(input.cwd, command.family);
  const route = resolveRoute({
    family: command.family,
    selection: command.selection,
    ...(project ? { project } : {}),
    reachable: reach,
  });
  if (route.status !== 'resolved') throw new RouteError(route);
  // In the route's (sorted) order, so the pick and the listing never depend on directory order.
  const candidates = route.signetIds.flatMap((signetId) =>
    reach.filter(
      (item) => item.signetId === signetId && item.integrationId === route.integrationId,
    ),
  );
  const resources = [
    ...new Map(
      candidates.flatMap((item) => item.resources).map((resource) => [resource.id, resource]),
    ).values(),
  ];
  const parsed = parser(command.args, { binary: command.binary, resources });
  if (isRefused(parsed)) throw Error(`${command.binary}: ${parsed.refused}`);
  const chosen = chooseSignet(candidates, parsed, command.family);
  if (chosen.status !== 'chosen') throw new RouteError(chosen);
  return (input.execute ?? executeWithSignet)(chosen.signet.credentialFile, {
    integrationId: route.integrationId,
    operation: parsed.operation,
    input: accessInputSchema.parse({ ...parsed.input, resourceId: parsed.resourceId }),
  });
}
