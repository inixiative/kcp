#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { heldCredentials, installationPaths } from './installation';
import { defaultKingdomUrl, kcpHome, savedKingdomUrl } from './kingdom';
import { NoOperationsError } from './operations';
import { formatMap, kingdomMap, readOverview } from './overview';
import { RouteError, runCommand } from './run';
import { redactSecrets } from './secrets';
import { SelectorError } from './selectors';
import { loginWithSignet, loginWithToken, logout, pairKcp, status } from './session';

export const usage = `KCP, the Kingdom CLI proxy

  kcp login [--url URL] [--name NAME] [--organization SLUG|ID] [--no-open]
  kcp login --token TOKEN|- [--signet SIGNET_ID] [--url URL]
  kcp login --token TOKEN|- --request -i INTEGRATION_ID --operation OP [--operation OP…]
  kcp login --signet FILE|SIGNET_ID [--token TOKEN|-] [--url URL]
  kcp logout [--url URL]
  kcp status [--url URL]
  kcp map [--json] [--token TOKEN|-] [--url URL]

  kcp [selectors] <railway|gh|git|vercel|infisical> <args…>
    -i INTEGRATION_ID   -o ORGANIZATION_ID   -s SPACE_ID   -u USER_ID
    -o ORG -u USER      organization membership
    -s SPACE -u USER    space membership
    --signet SIGNET_ID  --token TOKEN_ID

  TOKEN is a Kingdom API token; "-" reads it from stdin. KINGDOM_TOKEN also works.
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
  json: { type: 'boolean' },
  'no-open': { type: 'boolean' },
} as const;

async function apiToken(value: string | undefined, env: Record<string, string | undefined>) {
  if (value === '-') return (await Bun.stdin.text()).trim();
  return value ?? env.KINGDOM_TOKEN;
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export async function main(argv: readonly string[], env = process.env) {
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
  if (command === 'login') {
    const token = await apiToken(values.token, values.token ? {} : env);
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
    if (values.token) {
      if (!token) throw Error('--token needs a Kingdom API token');
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
    console.error(
      "Removed this machine's key and Signets. Revoke the Signets (and the KCP integration) in Kingdom too.",
    );
    print(removed);
    return 0;
  }
  if (command === 'status') {
    const current = await status(home, url);
    print(current);
    return current.loggedIn ? 0 : 1;
  }
  const token = await apiToken(values.token, env);
  if (!token)
    throw Error(
      'kcp map reads /me/overview, which takes a Kingdom API token (--token or KINGDOM_TOKEN), not a Signet',
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
