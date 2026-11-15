# kcp, for its Wardens

KCP (`@inixiative/kcp`), the Kingdom CLI Proxy, is a small published Bun/TypeScript package and the
`kcp` CLI. It lets an agent run provider CLIs (`railway`, `gh`, `vercel`, `infisical`) through
Kingdom with no provider credential on the machine: you sign in to Kingdom once, and a command
becomes a Signet `execute` call that Kingdom runs with the credential it holds. KCP never sends a
raw argument list. A per-provider parser turns the command into a declared operation's typed input;
a command that parses into no operation is never sent.

KCP is in progress, and answers must say so. Built: the three logins, `logout`, `status`, `map`,
selectors, routing, `.foundry/kcp.json`, the parser registry and the execute path. Not built: any
operation parser (every proxied command ends with `NoOperationsError` and sends nothing), the `kcp`
installation kind (browser pairing refuses and points at `--token` / `--signet`), Kingdom's runner,
output streaming, and the git credential helper (`git` is refused).

## Shape of the repository

- `src/`: one file per part. `src/index.ts` is the only export (`.`) and re-exports every module
  except `src/cli.ts`, which is the `kcp` bin.
- `test/`: bun tests and shared fixtures.
- `README.md` is the one doc. The design is Kingdom's `docs/OPERATOR-ACCESS.md` (in the Kingdom
  repo); source comments cite its sections (§4 git, §5 routing, §9 operations).

## Systems other code depends on

- `@inixiative/signet` holds keys, DPoP proofs, pairing, private files, the installation layout, the
  hold lock, enrollment and `SignetClient`. KCP imports these; it does not reimplement them.
- Selectors (`parseCommand`): `-i -o -s -u --signet` before the CLI name, ids are UUIDs, `--token`
  is never a selector, and the binary maps to a provider family.
- Routing (`resolveRoute`, then `chooseSignet` once the command is parsed) is pure: `--signet`, then
  `-i`, then owner flags, then the repo's `.foundry/kcp.json`, then the one matching integration,
  else `ask` (nothing matches) or `ambiguous` (several do). Contradicting flags are refused, never
  overridden.
- Session (`pairKcp`, `loginWithToken`, `loginWithSignet`, `logout`, `status`) writes under
  `KCP_HOME` (default `~/.kcp`), one directory per Kingdom host. A Kingdom API token is read from
  stdin or `KINGDOM_TOKEN`, used for the call and never stored.
- When a command fails, the CLI prints a plain `Error` or operator error (`SelectorError`, `RouteError`, `NoOperationsError`) by its message, any other error as a generic line, and both through `redactSecrets`.

## Words used here

Kingdom, Signet, integration, provider family, owner (User, Organization, Space, OrganizationUser,
SpaceUser), installation, pairing, enroll / hold, selector, route, declared operation, KCP_HOME.
