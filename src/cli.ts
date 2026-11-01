#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { heldCredentials, installationPaths } from '@inixiative/signet';
import { defaultKingdomUrl, kcpHome, savedKingdomUrl } from './kingdom';
import { NoOperationsError } from './operations';
import { formatMap, kingdomMap, readOverview } from './overview';
import { RouteError, runCommand } from './run';
import { redactSecrets } from './secrets';
import { SelectorError } from './selectors';
import {
  type EnrollCandidate,
  loginWithSignet,
  loginWithToken,
  logout,
  pairKcp,
  status,
} from './session';

export const usage = `KCP, the Kingdom CLI proxy

  kcp login [--url URL] [--name NAME] [--organization SLUG|ID] [--no-open]
  kcp login --token -|env [--signet SIGNET_ID | --yes] [--url URL]
  kcp login --token -|env --request -i INTEGRATION_ID --operation OP [--operation OP…]
  kcp login --signet FILE|SIGNET_ID [--token -|env] [--url URL]
  kcp logout [--url URL]
  kcp status [--url URL]
  kcp map [--json] --token -|env [--url URL]

  kcp [selectors] <railway|gh|vercel|infisical> <args…>
    -i INTEGRATION_ID   -o ORGANIZATION_ID   -s SPACE_ID   -u USER_ID
    -o ORG -u USER      organization membership
    -s SPACE -u USER    space membership
    --signet SIGNET_ID  that exact grant

  --token takes a Kingdom API token from stdin (-) or from KINGDOM_TOKEN (env), never as an
  argument. It is for Kingdom's own API (login, map), never a selector: integrations run only
  through Signets. Without --signet, login --token lists the Signets it would enroll and asks
  first; --yes accepts them when nothing can ask.
  git runs locally through KCP's git credential helper, which isn't built yet.
  The Kingdom is --url, else KINGDOM_URL, else the last login, else hosted production.
  Keys and Signets live in KCP_HOME (default ~/.kcp).`;

const sessionOptions = {
  url: { type: 'string' },
  token: { type: 'string' },
  signet: { type: 'string' },
  name: { type: 'string' },
  organization: { type: 'string' },
  integration: { type: 'string', short: 'i' },
  operation: { type: 'string', multiple: true },
  request: { type: 'boolean' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  'no-open': { type: 'boolean' },
} as const;

/** The terminal: stdin's whole text, one answered line, and whether a person can answer. */
export type Terminal = {
  readStdin: () => Promise<string>;
  ask: (question: string) => Promise<string | null>;
  interactive: boolean;
};

const terminal: Terminal = {
  readStdin: () => Bun.stdin.text(),
  ask: async (question) => {
    process.stderr.write(question);
    for await (const line of console) return line;
    return null;
  },
  interactive: Boolean(process.stdin.isTTY),
};

/**
 * A Kingdom API token from where `--token` says: `-` reads stdin, `env` reads KINGDOM_TOKEN. A
 * token on the command line would land in shell history and the process list, so it is refused.
 */
export async function apiToken(
  value: string | undefined,
  env: Record<string, string | undefined>,
  io: Pick<Terminal, 'readStdin'>,
) {
  if (value === undefined) return undefined;
  const token =
    value === '-'
      ? (await io.readStdin()).trim()
      : value === 'env'
        ? env.KINGDOM_TOKEN?.trim()
        : null;
  if (token === null)
    throw Error(
      '--token takes - (read the token from stdin) or env (read KINGDOM_TOKEN), never the token itself: an argument lands in shell history and the process list',
    );
  if (!token)
    throw Error(value === '-' ? 'No token on stdin' : 'KINGDOM_TOKEN is empty or not set');
  return token;
}

/** Lists what `login --token` would enroll, then takes --yes, or asks when a person can answer. */
const confirmEnrollment =
  (yes: boolean | undefined, io: Terminal, stdinUsed: boolean) =>
  async (candidates: readonly EnrollCandidate[]) => {
    console.error(`Signets issued to you that KCP would enroll on this machine:`);
    for (const candidate of candidates)
      console.error(
        `  ${candidate.family}  ${candidate.name}  --signet ${candidate.signetId}  (integration ${candidate.integrationId})`,
      );
    if (yes) return true;
    if (!io.interactive || stdinUsed) return false;
    const answer = await io.ask(`Enroll these ${candidates.length}? [y/N] `);
    return /^y(es)?$/i.test(answer?.trim() ?? '');
  };

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export async function main(argv: readonly string[], env = process.env, io = terminal) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage);
    return command ? 0 : 1;
  }
  const home = kcpHome(env);
  if (!['login', 'logout', 'status', 'map'].includes(command)) {
    const url = defaultKingdomUrl(undefined, await savedKingdomUrl(home), env);
    print(await runCommand({ argv, home, url, cwd: process.cwd() }));
    return 0;
  }
  const { values } = parseArgs({ args: [...rest], options: sessionOptions, strict: true });
  const url = defaultKingdomUrl(values.url, await savedKingdomUrl(home), env);
  const token = await apiToken(values.token, env, io);
  if (command === 'login') {
    if (values.signet) {
      print(
        await loginWithSignet({
          home,
          url,
          signet: values.signet,
          ...(token ? { apiToken: token } : {}),
          ...(values.name ? { name: values.name } : {}),
        }),
      );
      return 0;
    }
    if (token) {
      if (values.request && (!values.integration || !values.operation?.length))
        throw Error('--request needs -i INTEGRATION_ID and at least one --operation');
      print(
        await loginWithToken({
          home,
          url,
          apiToken: token,
          ...(values.request && values.integration && values.operation
            ? { request: { integrationId: values.integration, operations: values.operation } }
            : {}),
          ...(values.name ? { name: values.name } : {}),
          confirm: confirmEnrollment(values.yes, io, values.token === '-'),
          onReview: ({ reviewCode }) =>
            console.error(`Waiting for the owner to approve request ${reviewCode} in Kingdom…`),
        }),
      );
      return 0;
    }
    print(
      await pairKcp({
        home,
        url,
        ...(values.name ? { name: values.name } : {}),
        ...(values.organization ? { organization: values.organization } : {}),
        onReview: ({ review, reviewCode, expiresAt }) => {
          console.error(`Approve this KCP in Kingdom: ${review}`);
          console.error(
            `Confirm the review code matches: ${reviewCode} (expires ${new Date(expiresAt).toLocaleTimeString()})`,
          );
          if (!values['no-open'] && process.platform === 'darwin')
            Bun.spawn(['open', review], { stdout: 'ignore', stderr: 'ignore' });
          console.error('Waiting for approval…');
        },
        onWaiting: (message) => console.error(`Still waiting: ${message}`),
      }),
    );
    return 0;
  }
  if (command === 'logout') {
    const removed = await logout(home, url);
    console.error("Removed this machine's key and Signets.");
    if (removed.withdrawError)
      console.error(
        `Kingdom refused to withdraw the open pairing (${removed.withdrawError}); decline it in Kingdom.`,
      );
    const { signetIds, integrationId } = removed.revokeInKingdom;
    if (signetIds.length || integrationId)
      console.error(
        `Revoke in Kingdom: ${[
          ...signetIds.map((id) => `Signet ${id}`),
          ...(integrationId ? [`KCP integration ${integrationId}`] : []),
        ].join(', ')}`,
      );
    print(removed);
    return removed.withdrawError ? 1 : 0;
  }
  if (command === 'status') {
    const current = await status(home, url);
    print(current);
    return current.loggedIn ? 0 : 1;
  }
  if (!token)
    throw Error(
      'kcp map reads /me/overview, which takes a Kingdom API token (--token - or --token env), not a Signet',
    );
  const held = await heldCredentials(installationPaths(home, url).directory);
  const owners = kingdomMap(
    await readOverview(url, token),
    new Set(held.map((credential) => credential.signetId)),
  );
  console.log(values.json ? JSON.stringify(owners, null, 2) : formatMap(owners));
  return 0;
}

const operatorErrors = [SelectorError, RouteError, NoOperationsError];

if (import.meta.main)
  main(Bun.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message =
        error instanceof Error &&
        (error.name === 'Error' || operatorErrors.some((type) => error instanceof type))
          ? error.message
          : 'kcp failed; check the Kingdom address and KCP_HOME';
      console.error(redactSecrets(message));
      process.exitCode = 1;
    },
  );
