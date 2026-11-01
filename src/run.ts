import { SignetClient } from '@inixiative/signet';
import { accessInputSchema } from '@inixiative/signet/contracts';
import { type HolderView, SignetHolders } from './holders';
import { heldCredentials, installationPaths } from './installation';
import {
  isRefused,
  type OperationParser,
  type OperationResource,
  operationParsers,
  parseOperation,
} from './operations';
import { findProjectFile, projectSelections, readProject } from './project';
import { type Reachable, type Route, resolveRoute } from './routing';
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
      ...route.candidates.map(
        (candidate) =>
          `  -i ${candidate.integrationId}  ${candidate.name ?? ''}${candidate.signetId ? '' : '  (no Signet held)'}`,
      ),
    ].join('\n');
  const target = route.integrationId ? ` on integration ${route.integrationId}` : '';
  return `${route.reason}. Ask the integration's owner to grant this machine a Signet${target} for ${route.family}, then run kcp status.`;
}

export type HeldReach = Reachable & {
  signetId: string;
  credentialFile: string;
  resources: OperationResource[];
};

/** What this machine's held Signets reach, as Kingdom describes them; revoked or unread ones are left out. */
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
    const resources = new Map<string, OperationResource>();
    for (const operation of description.operations)
      for (const resource of operation.resources)
        resources.set(resource.id, { id: resource.id, name: resource.name, kind: resource.kind });
    return [
      {
        integrationId: description.integrationId,
        provider: description.provider,
        owner: credential.owner ?? null,
        name: description.name,
        signetId: credential.signetId,
        credentialFile: credential.credentialFile,
        resources: [...resources.values()],
      },
    ];
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
 * `kcp <selectors> <cli> <args…>`: route to an integration and a held Signet, parse the command
 * into a declared operation's typed input, and execute it through the Signet. The argv itself is
 * never sent.
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
  const held = reach.find((item) => item.signetId === route.signetId);
  if (!held) throw Error(`Signet ${route.signetId} is not held here`);
  const parsed = parseOperation(
    command.family,
    command.args,
    { binary: command.binary, resources: held.resources },
    input.parsers ?? operationParsers,
  );
  if (isRefused(parsed)) throw Error(`${command.binary}: ${parsed.refused}`);
  return (input.execute ?? executeWithSignet)(held.credentialFile, {
    integrationId: route.integrationId,
    operation: parsed.operation,
    input: accessInputSchema.parse({ ...parsed.input, resourceId: parsed.resourceId }),
  });
}
