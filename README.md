# @inixiative/kcp

> Part of [inixiative](https://www.inixiative.com), technology for cooperation. See [all the projects](https://github.com/inixiative).

KCP, the Kingdom CLI Proxy: run your provider CLIs through Kingdom with no credentials on your machine. Kingdom runs the command and streams the output back. **In progress:** the client (`kcp login`, `status`, `map`) is built; no operations are declared yet and Kingdom's runner is not built, so commands do not run end to end.

Agents kept stalling on expired CLI logins (Railway, Infisical) and on a plaintext Kingdom token in a dotfile. With KCP you sign in to Kingdom once, and a command such as `railway logs` or `gh pr list` becomes a Signet `execute` call. Kingdom holds each integration's long-lived credential, runs the real CLI on its runner, and streams the output back. The credential never reaches the machine, and Kingdom never receives a raw argument list: KCP parses the command into a declared operation's typed input, and a command that parses into no operation has nothing to grant, so it is never sent.

The design is Kingdom's `docs/OPERATOR-ACCESS.md`. KCP is the thin client in it, built on [`@inixiative/signet`](https://github.com/inixiative/signet), which holds the one implementation of keys, DPoP proofs, pairing and private files.

## Commands

```
kcp login [--url URL] [--name NAME] [--organization SLUG|ID] [--no-open]
kcp login --token -|env [--signet SIGNET_ID | --yes] [--url URL]
kcp login --token -|env --request -i INTEGRATION_ID --operation OP [--operation OP…]
kcp login --signet FILE|SIGNET_ID [--token -|env] [--url URL]
kcp logout [--url URL]
kcp status [--url URL]
kcp map [--json] --token -|env [--url URL]

kcp [selectors] <railway|gh|vercel|infisical> <args…>
```

Every login ends the same way: a device key plus one credential file per Signet, private (0700 directory, 0600 files) under `KCP_HOME` (default `~/.kcp`), one directory per Kingdom host. The layout is `@inixiative/signet`'s installation layout (`<host>/installation-key.json`, `<host>/signet-<id>.json`), so a Foundry or Archive reads it the same way.

- **`kcp login`** pairs this machine as a KCP installation (`pairInstallation`). A person approves it in Kingdom as an owner, and Kingdom creates that owner's KCP integration. The owner then grants the integration Signets on Railway, GitHub and the rest; KCP enrolls each grant (`holdInstallationSignets`) at login, on `status` and before each command.
- **`kcp login --token`** acts as the person a Kingdom API token belongs to. With `--signet <id>` it enrolls this key on that one Signet. Without, it lists the Signets issued to the person, or to one of their memberships (OrganizationUser, SpaceUser), on integrations whose provider family KCP serves (by the `family` in Kingdom's provider catalog) and not held here yet, and enrolls them only once confirmed: a prompt when a person can answer, `--yes` otherwise. Enrollment goes through `@inixiative/signet`'s `holdPersonSignets`, under the same per-directory hold lock as installation syncs, so two logins (or a login and a sync) never enroll over each other. With `--request -i … --operation …` it asks for a Signet on that integration's resources instead (`requestSignet`) and waits for the owner (`awaitSignet`).
- **The token never goes on the command line.** `--token -` reads it from stdin; `--token env` reads `KINGDOM_TOKEN`, which is read only when `--token env` asks for it. Any other value is refused, because an argument lands in shell history and the process list. The token is used for the call and never stored. A Kingdom API token is for Kingdom's own API (`login`, `map`); it never reaches an integration.
- **`kcp login --signet <file>`** copies an existing credential file in; its key stays where it is. **`--signet <id>`** enrolls that Signet through the paired installation (`enrollInstallationSignet`), or as its person with `--token`.
- **`kcp logout`** withdraws an open pairing and deletes this machine's key and Signets for that Kingdom. Revoking stays with Kingdom, so it prints the Signet ids (and the KCP integration, if paired) the owner should revoke there. A withdrawal Kingdom refused is reported, and the command exits 1.
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

Every id is a UUID. A flag repeated with a different id and an unknown flag before the CLI are errors. `--token` is not a selector: a Token never reaches an integration's resources, so it is refused here with a pointer to `--signet`. Binaries map to provider families: `railway` → railway, `gh` → github, `vercel` → vercel, `infisical` → infisical. Anything else is refused.

`git` is refused too, with its own message. `git push` and `git fetch` read the working tree, so they run on this machine with a short-lived credential from KCP's git credential helper (OPERATOR-ACCESS §4), never as a Kingdom `execute`. The helper isn't built yet.

## Routing

`resolveRoute` is a pure function over what this machine can reach (each held Signet, as `access/describe` reports it). It follows OPERATOR-ACCESS §5:

1. `--signet` wins. It must be held here, on the CLI's provider, and on `-i`'s integration if both are given.
2. `-i` next.
3. The owner flags: the owner's one integration of that provider.
4. With no flags, the repo's `.foundry/kcp.json`.
5. The one matching integration.
6. Nothing resolves: an `ask` result telling the agent to have the owner grant a Signet. Several integrations matching is `ambiguous`, listing each `-i`.

Flags that contradict each other are refused, never overridden: owner flags beside `--signet` or `-i` must name the owner of that Signet or integration, and when this machine doesn't know that owner, the pair is refused as uncheckable.

Matches are grouped by integration, so two Signets held on one integration are one match. Routing ends at an integration and every Signet held on it; KCP then parses the command and `chooseSignet` picks the Signet that grants the parsed operation on the parsed resource. The only held Signet is used whatever it grants (Kingdom judges); several held and none granting it is `ambiguous`, listing each `--signet`.

When the owner holds several credentials on the chosen integration, Kingdom's pool picks; that is Kingdom's side (§5.5).

### `.foundry/kcp.json`

Committed in the repo, found from the working directory up to the repo root (the first directory with `.git`). Outside a repo there is none: a walk that reaches `$HOME` or the filesystem root without finding `.git` reads nothing, and it never goes above `$HOME`. Each provider maps to the same ids the flags take: an integration, or an owner whose one integration of that provider is used.

```json
{
  "providers": {
    "railway": { "organizationId": "01a196f0-a68e-7d81-a8cd-fc92e07fb9bf" },
    "github": { "integrationId": "…" }
  }
}
```

## Running a command

`kcp <selectors> <cli> <args…>` first looks up the provider's operation parser (`operationParsers`); with none, it stops there, before any call to Kingdom. Otherwise it routes to an integration, and the parser turns argv into `{ operation, resourceId, input }`, typed by the operation `@inixiative/signet` declares (`DeclaredOperation`, `OperationInput`), or refuses and says why. KCP picks the held Signet that grants it and calls `SignetClient.execute` with that typed input. No parser exists yet, so every command ends with `No operations are declared for <provider> yet`, and nothing is sent.

## Built and pending

Built (v0): the three logins, `logout`, `status`, `map`, selector parsing, routing, `.foundry/kcp.json`, the parser registry and the execute path behind it.

Waiting on Kingdom and `@inixiative/signet`:

- **The `kcp` installation kind.** Browser pairing needs `kcp` in signet's `installationKindSchema`, Kingdom's `InstallationKind` and `Provider` enums, and its catalog. None of the existing kinds fits: pairing as `foundry` creates a Foundry integration with a `threads` resource, `oracle` would show as an Oracle, and `archive` requires a `sourceId`. Until then `kcp login` says so and points to `--token` and `--signet`; once signet declares the kind, it works with no KCP change.
- **CLI operations** (§9, §11 step 1): resource kinds and operation input schemas for Railway, GitHub, Vercel and Infisical in signet's contracts, then one parser each here.
- **The runner** and its delivery value (§6), and **output streaming** over the Signet socket. Until then `execute` returns the result whole.
- **`/me/overview` through a Signet.** The overview is a user route (JWT or API token), so `kcp map` needs `--token`. Routing doesn't: it reads the held Signets through `access/describe`.
- **`credential.release`** for the git credential helper and local commands (§4), then `kcp shims install` and `kcp hook claude|codex`. Until the helper exists, `kcp git …` is refused.
- **Membership recipients in Kingdom.** `login --token` offers Signets issued to the person's OrganizationUser and SpaceUser memberships (matched by the recipient's user id), but Kingdom's `SignetRecipientModel` is `User | Integration` today and `/me/overview` lists only those, so none arrive yet.

## Moving from Foundry

The generic installation helpers live in `@inixiative/signet` (0.8.0), so KCP, Foundry, Archive and Oracle share one implementation; KCP imports them. Foundry (`packages/foundry/src/providers/`) can import them in place of its own. Their signatures take a root directory where Foundry's took its config directory (Foundry passes `kingdomInstallationRoot(configDir)`).

| Foundry | Now | Signature difference |
|---|---|---|
| `kingdom-installation-connection.ts` `kingdomInstallationPaths(configDir, url)` | signet `installationPaths(root, url)` | root, not config dir |
| `kingdom-installation-connection.ts` `listedSignets(configDir, urls)` | signet `listedSignets(root, urls)` | root, not config dir |
| `kingdom-installation-connection.ts` `heldSignetFile(configDir, url, signetId)` | signet `heldSignetFile(root, url, signetId)` | root, not config dir; error text says "installation", not "Foundry" |
| `kingdom-pairing.ts` `privateDirectory(configDir)` | signet `privateDirectory(path)` | error names the path |
| `kingdom-cli.ts` `defaultInstallationName()` | signet `defaultInstallationName(product)` | product name is a parameter: `defaultInstallationName('Foundry')` |
| `kingdom-client.ts` `ownerKey`, `ownerKeySchema` | signet contracts `ownerKey`, `ownerKeySchema`, next to `ownerRefSchema` | `ownerKey` takes `ownerModel` plus optional nullable ids, so Foundry's looser `OwnerRef` fits |
| `kingdom-holder.ts` `KingdomHolders`, `parseHeldSignetDescription`, `HolderView` | signet `SignetHolders`, `parseHeldSignetDescription`, `HolderView` | holder schema `.nullable()` as Foundry's. `SignetHolders<Ref>` takes refs `{ url, signetId, credentialFile }` (Foundry's `get` took a `KingdomIntegration`); `keyOf` sets the cache key (default the credential file), so Foundry keeps `forget(kingdomIntegrationId(...))` with `keyOf: kingdomIntegrationId` on refs that carry `owner`. No `configDir` constructor argument. `describe(ref)` takes the ref, where Foundry's took `(credentialFile, url, signetId)`. `HolderView` also carries the parsed `description` |
| `kingdom-pairing.ts` `withdrawKingdomRegistration(configDir, url)` | signet `withdrawRegistration(root, url)` | root, not config dir; both throw Kingdom's refusal |
| KCP `heldCredentials` | signet `heldCredentials(directory)` | none |
| (new) | signet `holdPersonSignets(url, keyFile, directory, apiToken, signets, { name, replace })`, `withHoldLock(directory, fn)` | person enrollment under the installation hold lock |

Still in KCP: `HOSTED_KINGDOM_URL` and `defaultKingdomUrl(flag, saved, env)` (`kingdom.ts`), `redactSecrets` (`secrets.ts`). Still in Foundry because they depend on its `ConfigStore`, viewer or logger: `pairKingdom`, `pairKingdomIntegration`, `saveKingdomIntegration`, `disconnectKingdom`, `kingdomStatus`, `viewerRunning`, `shareViewerCredential` and the `KingdomInstallationConnection(s)` socket holders. `kingdom-token-helper.ts` `kingdomToken` moves when the git credential helper is built here.

## Development

```
bun install
bun run check   # typecheck, Biome, tests
```

MIT
