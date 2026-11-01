# @inixiative/kcp

KCP, the Kingdom CLI proxy.

Agents kept stalling on expired CLI logins (Railway, Infisical) and on a plaintext Kingdom token in a dotfile. KCP is the fix: you sign in to Kingdom once, and a command such as `railway logs` or `gh pr list` becomes a Signet `execute` call. Kingdom holds each integration's long-lived credential, runs the real CLI on its runner, and streams the output back. The credential never reaches the machine, and Kingdom never receives a raw argument list: KCP parses the command into a declared operation's typed input, and a command that parses into no operation has nothing to grant, so it is never sent.

The design is Kingdom's `docs/OPERATOR-ACCESS.md`. KCP is the thin client in it, built on [`@inixiative/signet`](https://github.com/inixiative/signet), which holds the one implementation of keys, DPoP proofs, pairing and private files.

## Commands

```
kcp login [--url URL] [--name NAME] [--organization SLUG|ID] [--no-open]
kcp login --token TOKEN|- [--signet SIGNET_ID] [--url URL]
kcp login --token TOKEN|- --request -i INTEGRATION_ID --operation OP [--operation OP…]
kcp login --signet FILE|SIGNET_ID [--token TOKEN|-] [--url URL]
kcp logout [--url URL]
kcp status [--url URL]
kcp map [--json] [--token TOKEN|-] [--url URL]

kcp [selectors] <railway|gh|git|vercel|infisical> <args…>
```

Every login ends the same way: a device key plus one credential file per Signet, private (0700 directory, 0600 files) under `KCP_HOME` (default `~/.kcp`), one directory per Kingdom host. The layout is `@inixiative/signet`'s installation layout (`<host>/installation-key.json`, `<host>/signet-<id>.json`), so a Foundry or Archive reads it the same way.

- **`kcp login`** pairs this machine as a KCP installation (`pairInstallation`). A person approves it in Kingdom as an owner, and Kingdom creates that owner's KCP integration. The owner then grants the integration Signets on Railway, GitHub and the rest; KCP enrolls each grant (`holdInstallationSignets`) at login, on `status` and before each command.
- **`kcp login --token`** acts as the person a Kingdom API token belongs to. It reads `/me/overview` and enrolls this key on every Signet issued to that person (`enrollSignet`), or on the one `--signet` names. With `--request -i … --operation …` it asks for a Signet on that integration's resources instead (`requestSignet`) and waits for the owner (`awaitSignet`). The token is used for the call and never stored. `-` reads it from stdin, so it stays out of shell history; `KINGDOM_TOKEN` also works.
- **`kcp login --signet <file>`** copies an existing credential file in; its key stays where it is. **`--signet <id>`** enrolls that Signet through the paired installation (`enrollInstallationSignet`), or as its person with `--token`.
- **`kcp logout`** withdraws an open pairing and deletes this machine's key and Signets for that Kingdom. Revoking the Signets and the KCP integration stays with Kingdom.
- **`kcp status`** shows the pairing and each held Signet as Kingdom describes it now (`described`, `revoked` or `unavailable`), with its integration, provider and owner.
- **`kcp map`** prints every owner you can reach and their integrations, with ids to pass to `-i`, and marks the ones you manage and the Signets this machine holds. `--json` prints the structure.

The Kingdom is `--url`, else `KINGDOM_URL`, else the one the last login used, else `https://api.kingdom.inixiative.com`.

## Selectors

Selectors come before the CLI; everything after the CLI's name is its own.

| Flags | Means |
|---|---|
| `-i <integrationId>` | that integration |
| `-o <organizationId>` | the organization |
| `-s <spaceId>` | the space |
| `-u <userId>` | the user |
| `-o <org> -u <user>` | the organization membership (OrganizationUser) |
| `-s <space> -u <user>` | the space membership (SpaceUser); `-o` may say which organization |
| `--signet <signetId>` | that exact grant |
| `--token <tokenId>` | parsed, but refused by routing (see below) |

Every id is a UUID. `--signet` and `--token` together, a flag repeated with a different id, and an unknown flag before the CLI are errors. Binaries map to provider families: `railway` → railway, `gh` and `git` → github, `vercel` → vercel, `infisical` → infisical. Anything else is refused.

## Routing

`resolveRoute` is a pure function over what this machine can reach (each held Signet, as `access/describe` reports it). It follows OPERATOR-ACCESS §5:

1. `--signet` wins. It must be held here, on the CLI's provider, and on `-i`'s integration if both are given.
2. `-i` next. It overrides the owner flags.
3. The owner flags: the owner's one integration of that provider.
4. With no flags, the repo's `.foundry/kcp.json`.
5. The one matching integration.
6. Nothing resolves: an `ask` result telling the agent to have the owner grant a Signet. Several matches are `ambiguous`, listing each `-i`.

When the owner holds several credentials on the chosen integration, Kingdom's pool picks; that is Kingdom's side (§5.5), so KCP stops at the integration.

### `.foundry/kcp.json`

Committed in the repo, found from the working directory up to the repo root. Each provider maps to the same ids the flags take: an integration, or an owner whose one integration of that provider is used.

```json
{
  "providers": {
    "railway": { "organizationId": "01a196f0-a68e-7d81-a8cd-fc92e07fb9bf" },
    "github": { "integrationId": "…" }
  }
}
```

## Running a command

`kcp <selectors> <cli> <args…>` routes to an integration and a held Signet, then looks up the provider's operation parser (`operationParsers`). A parser turns argv into `{ operation, resourceId, input }`, typed by the operation `@inixiative/signet` declares (`DeclaredOperation`, `OperationInput`), or refuses and says why. KCP then calls `SignetClient.execute` with that typed input. No parser exists yet, so every command ends with `No operations are declared for <provider> yet`, and nothing is sent.

## Built and pending

Built (v0): the three logins, `logout`, `status`, `map`, selector parsing, routing, `.foundry/kcp.json`, the parser registry and the execute path behind it.

Waiting on Kingdom and `@inixiative/signet`:

- **The `kcp` installation kind.** Browser pairing needs `kcp` in signet's `installationKindSchema`, Kingdom's `InstallationKind` and `Provider` enums, and its catalog. None of the existing kinds fits: pairing as `foundry` creates a Foundry integration with a `threads` resource, `oracle` would show as an Oracle, and `archive` requires a `sourceId`. Until then `kcp login` says so and points to `--token` and `--signet`; once signet declares the kind, it works with no KCP change.
- **CLI operations** (§9, §11 step 1): resource kinds and operation input schemas for Railway, GitHub, Vercel and Infisical in signet's contracts, then one parser each here.
- **The runner** and its delivery value (§6), and **output streaming** over the Signet socket. Until then `execute` returns the result whole.
- **`/me/overview` through a Signet.** The overview is a user route (JWT or API token), so `kcp map` needs `--token`. Routing doesn't: it reads the held Signets through `access/describe`.
- **`credential.release`** for the git credential helper and local commands (§4), then `kcp shims install` and `kcp hook claude|codex`.

## Moving from Foundry

These Foundry functions (`packages/foundry/src/providers/`) have no Foundry-only dependency and now have their home here. Foundry can import them in place of its own; signatures take a root directory where Foundry's took its config directory (Foundry passes `kingdomInstallationRoot(configDir)`).

| Foundry | KCP |
|---|---|
| `kingdom-pairing.ts` `HOSTED_KINGDOM_URL` | `HOSTED_KINGDOM_URL` (`kingdom.ts`) |
| `kingdom-cli.ts` `defaultKingdomUrl` | `defaultKingdomUrl(flag, saved, env)` |
| `kingdom-cli.ts` `defaultInstallationName` | `defaultInstallationName` (`session.ts`) |
| `kingdom-client.ts` `ownerKey`, `ownerKeySchema` | `ownerKey`, `ownerKeySchema` (`owner.ts`) |
| `kingdom-installation-connection.ts` `kingdomInstallationPaths` | `installationPaths(root, url)` (`installation.ts`) |
| `kingdom-installation-connection.ts` `listedSignets` | `listedSignets(root, urls)` |
| `kingdom-installation-connection.ts` `heldSignetFile` | `heldSignetFile(root, url, signetId)` |
| `kingdom-pairing.ts` `withdrawKingdomRegistration` | `withdrawRegistration(root, url)` |
| `kingdom-pairing.ts` `privateDirectory` | `privateDirectory(path)` |
| `kingdom-holder.ts` `KingdomHolders`, `parseHeldSignetDescription` | `SignetHolders`, `parseHeldSignetDescription` (`holders.ts`), keyed by credential file and also returning the description |
| `kingdom-secrets.ts` | `secrets.ts`, plus `redactSecrets` |

Still in Foundry because they depend on its `ConfigStore`, viewer or logger: `pairKingdom`, `pairKingdomIntegration`, `saveKingdomIntegration`, `disconnectKingdom`, `kingdomStatus`, `viewerRunning`, `shareViewerCredential` and the `KingdomInstallationConnection(s)` socket holders. `kingdom-token-helper.ts` `kingdomToken` moves when the git credential helper is built here.

## Development

```
bun install
bun run check   # typecheck, Biome, tests
```

MIT
