# kcp glossary

**Every term kcp's region Wardens use, alphabetical, each with the region that holds it.**

<!-- Generated with the region Warden docs by the region pipeline's assemble.py. A term defined by two regions appears once per region. -->

---

## A

**access/describe**  
Signet call reporting what a held Signet reaches; heldReach uses it. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**ambiguous**  
Route result when several integrations or Signets match; lists each -i or --signet. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**api-token-input**  
Class: reading a Kingdom API token only from stdin or KINGDOM_TOKEN; never argv, never stored. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**/api/v1/me/overview**  
Kingdom's user route listing owners, integrations and Signets the viewer can reach. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**ask**  
Route result when nothing resolves: have the owner grant a Signet. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

## B

**bun run check**  
Runs typecheck, Biome and the bun tests. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

## C

**CLI operations**  
Pending resource kinds and input schemas per provider in signet's contracts (§9, §11). *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**cli-dispatch**  
Class: the kcp bin's main dispatcher and usage text in src/cli.ts. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**credential.release**  
Pending Kingdom capability behind the git helper, kcp shims install and kcp hook. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

## D

**declared operation**  
An operation signet's contracts declare; a command must parse into one to be sent. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**declared operation**  
An operation signet's contracts declare; a command must parse into one to be sent. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**described / revoked / unavailable**  
A held Signet's state as kcp status reports it from Kingdom. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**dev-checks**  
Class: bun install and bun run check (typecheck, Biome, bun tests). *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

## E

**enrollment**  
Registering this machine's key on a Signet so it can present it. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

## F

**.foundry/kcp.json**  
Committed repo file mapping each provider to an integration or owner; used only with no flags. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

## G

**git credential helper**  
Planned local path for git push/fetch (OPERATOR-ACCESS §4); not built, so git is refused. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**git credential helper**  
Pending local helper (§4); until it exists kcp git is refused. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

## H

**hold lock**  
signet's per-directory lock so concurrent logins and syncs never enroll over each other. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**holdPersonSignets / holdInstallationSignets**  
@inixiative/signet functions that enroll Signets under the hold lock. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**HOSTED_KINGDOM_URL**  
https://api.kingdom.inixiative.com, defaultKingdomUrl's final fallback. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

## I

**-i / -o / -s / -u / --signet**  
Integration, organization, space, user, exact grant; -o or -s with -u is a membership. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**@inixiative/signet**  
The one implementation of keys, DPoP proofs, pairing, private files and the Signet client. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**installation layout**  
@inixiative/signet's private files: <host>/installation-key.json and <host>/signet-<id>.json. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

## K

**KCP**  
Kingdom CLI Proxy: the @inixiative/kcp package and the kcp bin. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**kcp installation kind**  
Pending kind needed in signet's installationKindSchema and Kingdom for browser pairing. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**kcp installation kind**  
The installation kind pairing needs; not yet in signet or Kingdom, so pairing refuses. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**KCP integration**  
The integration Kingdom creates for the approving owner; the owner grants it Signets. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**kcp-design**  
Class: what KCP is and is not; thin client, no credential on the machine, no raw argv. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**kcp-status**  
Class: what is built versus pending and what waits on signet or Kingdom. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**KCP_HOME**  
KCP's private directory (default ~/.kcp), one subdirectory per Kingdom host; resolved by kcpHome. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**Kingdom**  
Holds each integration's long-lived credential and runs the real CLI on its runner. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**Kingdom**  
The service that holds each integration's long-lived credential and runs Signet execute calls. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**Kingdom API token**  
A person's token for Kingdom's own API (login, map); never stored, never sent to an integration. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**kingdom-map**  
Class: kcp map and the /api/v1/me/overview read into owners and integrations. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**kingdom-settings**  
Class: which Kingdom URL a command uses and where KCP_HOME is. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**KINGDOM_TOKEN**  
Env var read only when --token env asks for it. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**KINGDOM_URL**  
Env var naming the Kingdom; after --url, before the last login's URL. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

## L

**login-session**  
Class: kcp login (pairing, --token, --signet), logout and status over signet's installation layout. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

## M

**main**  
src/cli.ts dispatcher for the kcp bin; internal, not exported. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**membership recipients**  
Pending: Kingdom's SignetRecipientModel is User | Integration, so membership Signets don't arrive yet. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

## N

**NoOperationsError**  
No parser for the provider, so nothing is sent (every command today). *Region:* [Proxying a provider command](command-proxy/knowledge.md)

## O

**operation-parsers**  
Class: per-provider parsers turning argv into a declared operation's typed input. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**OperationParser**  
Turns one CLI's argv into a ParsedOperation or a RefusedOperation. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**OPERATOR-ACCESS §5**  
Kingdom's routing rules, which resolveRoute implements. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**OPERATOR-ACCESS.md**  
Kingdom's design doc for operator access, in the Kingdom repo; KCP is the thin client in it. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**output streaming**  
Pending streaming over the Signet socket; execute returns the result whole until then. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**owner**  
An organization, space, user or membership (OrganizationUser, SpaceUser) that owns integrations. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

## P

**pairing**  
Plain kcp login: this machine becomes an installation an owner approves (pairKcp). *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**ParsedOperation**  
{ operation, resourceId, input }, typed by signet's DeclaredOperation / OperationInput. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**project-mapping**  
Class: the repo's committed .foundry/kcp.json. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**provider family**  
railway, github, vercel or infisical; binaries railway, gh, vercel, infisical map to them. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**provider family**  
railway, github, vercel or infisical, from the family in Kingdom's provider catalog. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**public surface**  
The single '.' export (src/index.ts, every module but cli.ts) plus the kcp bin. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

## R

**Reachable**  
One held Signet's reach on one integration, as access/describe reports it. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**RefusedOperation**  
A parser's refusal with its reason; detect with isRefused. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**requestSignet / awaitSignet**  
signet calls behind login --token --request: ask the owner for a Signet, then wait. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**Route**  
resolveRoute's result: an integration with its held Signets, or ask / ambiguous. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**RouteError**  
No single integration and Signet resolved; carries routeMessage's next steps. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**routing**  
Class: picking the integration and Signet per OPERATOR-ACCESS §5. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**run-path**  
Class: kcp <cli> <args> end to end: parse, route, parser, Signet execute. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**runner**  
Kingdom's pending executor for CLI operations (§6). *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

## S

**secret-redaction**  
Class: removing secrets from text before it is printed (redactSecrets). *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**Selection**  
The validated selector ids (integration, owner, signet) a command or repo mapping names. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**SelectorError**  
Bad command line: unknown, repeated or non-UUID selector, --token, git, or an unserved CLI. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**selectors**  
Class: the -i -o -s -u --signet flags before the provider CLI, and the binary->family map. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

**Signet**  
An owner's grant on an integration's resources, held here as one credential file. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**Signet execute**  
The call a proxied command becomes; Kingdom runs it with the held credential. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)

**Signet renewal credential**  
Secret inside a held Signet that redactSecrets strips from printed text. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

**SignetClient.execute**  
@inixiative/signet call that runs the operation with typed input in Kingdom. *Region:* [Proxying a provider command](command-proxy/knowledge.md)

## T

**--token -|env**  
The only token sources: stdin or KINGDOM_TOKEN; any other value is refused. *Region:* [Kingdom login and session](kingdom-session/knowledge.md)

## U

**usage**  
src/cli.ts help text; internal, not exported. *Region:* [KCP scope and the kcp bin](kcp-scope-and-cli/knowledge.md)
