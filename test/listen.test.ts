import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessEventsStreamName, type EventChannelMap } from '@inixiative/signet/contracts';
import type { ServerWebSocket } from 'bun';
import { main, usage } from '../src/cli';
import { heldListeners, listen } from '../src/listen';
import type { Selection } from '../src/selectors';
import {
  credentials,
  description,
  eventChannel,
  holdSignet,
  id,
  orgOwner,
  token43,
  tribe,
} from './fixtures';

/**
 * A loopback Kingdom, after `@inixiative/signet`'s `test/eventStreams.test.ts`: it answers
 * `access/describe` with each Signet's event channels, accepts every Signet presentation on the
 * socket, records what each presenter sends, and sends only what a test tells it to.
 */
type Presenter = ServerWebSocket<{ signetId: string | null }>;
const tokens = new Map<string, string>();
const described = new Map<string, unknown>();
const presenters = new Map<string, Presenter>();
const frames: { signetId: string | null; action: unknown; stream: unknown }[] = [];
let upgrades = 0;
let kingdom: ReturnType<typeof Bun.serve>;
let url = '';
const seeded = 1_762_000_000_000_000;

beforeAll(() => {
  kingdom = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, server) {
      if (request.headers.get('upgrade') === 'websocket') {
        upgrades++;
        return server.upgrade(request, { data: { signetId: null } })
          ? undefined
          : new Response(null, { status: 426 });
      }
      const action = new URL(request.url).pathname.split('/').at(-1);
      if (action === 'nonce') return Response.json({ data: { nonce: token43('n') } });
      if (action === 'describe') {
        const { signetId } = (await request.json()) as { signetId: string };
        const answer = described.get(signetId);
        return answer ? Response.json({ data: answer }) : new Response(null, { status: 403 });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws: Presenter) {
        ws.send(JSON.stringify({ type: 'connected', connectionId: Bun.randomUUIDv7() }));
      },
      message(ws: Presenter, raw) {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.action === 'ping') return;
        if (frame.action === 'authenticateSignet') {
          const signetId = tokens.get(String(frame.accessToken)) ?? null;
          if (!signetId) return void ws.send(JSON.stringify({ type: 'signetRejected' }));
          ws.data.signetId = signetId;
          presenters.set(signetId, ws);
          ws.send(
            JSON.stringify({
              type: 'signet',
              signetId,
              enrollmentId: credentials().enrollmentId,
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }),
          );
          return;
        }
        frames.push({ signetId: ws.data.signetId, action: frame.action, stream: frame.stream });
      },
      close(ws: Presenter) {
        if (ws.data.signetId && presenters.get(ws.data.signetId) === ws)
          presenters.delete(ws.data.signetId);
      },
    },
  });
  url = `http://127.0.0.1:${kingdom.port}`;
});
afterAll(() => kingdom.stop(true));

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  for (const start = Date.now(); !predicate(); await Bun.sleep(5))
    if (Date.now() - start > timeoutMs) throw Error('waitFor timed out');
};
const settle = () => Bun.sleep(40);
const stream = (signetId: string, resourceId: string) =>
  accessEventsStreamName({ resourceId, signetId });
const sent = (action: string, signetId: string, resourceId: string) =>
  frames.filter(
    (frame) =>
      frame.action === action &&
      frame.signetId === signetId &&
      frame.stream === stream(signetId, resourceId),
  ).length;
const toHolder = (signetId: string, frame: Record<string, unknown>) =>
  presenters.get(signetId)?.send(JSON.stringify(frame));
const opened = (signetId: string, resourceId: string, seq = seeded) => {
  toHolder(signetId, { type: 'opened', stream: stream(signetId, resourceId) });
  toHolder(signetId, {
    category: 'data',
    action: 'snapshot',
    stream: stream(signetId, resourceId),
    seq,
    payload: { data: { events: [] } },
  });
};
const appended = (signetId: string, resourceId: string, seq: number, payload: unknown) =>
  toHolder(signetId, {
    category: 'data',
    action: 'append',
    stream: stream(signetId, resourceId),
    seq,
    type: 'append',
    payload,
  });
const closedBy = (signetId: string, resourceId: string, reason: string) =>
  toHolder(signetId, { type: 'closed', stream: stream(signetId, resourceId), reason });

const linearSignet = id(11);
const slackSignet = id(12);
const engineering = id(21);
const design = id(22);
const general = id(23);
const accessToken = (signetId: string) => `kingdom_${token43(signetId.slice(-2))}`;
const issue = (eventId: string, title: string) => ({
  eventId,
  type: 'Issue.create',
  event: { at: '2026-11-13T10:02:03.000Z', scope: 'ENG', subject: { title } },
});
const linearChannels: EventChannelMap = [
  {
    integration: { id: id(1), provider: 'linear', name: 'Tribe Linear' },
    channels: [
      eventChannel(linearSignet, engineering, {
        kind: 'team',
        name: 'Engineering',
        events: ['events.Issue.create', 'events.Issue.update'],
      }),
      eventChannel(linearSignet, design, {
        kind: 'team',
        name: 'Design',
        events: ['events.Comment.create'],
      }),
    ],
  },
];
const slackChannels: EventChannelMap = [
  {
    integration: { id: id(2), provider: 'slack', name: 'Tribe Slack' },
    channels: [
      eventChannel(slackSignet, general, {
        kind: 'channel',
        name: 'general',
        events: ['events.message.channels'],
      }),
    ],
  },
];

const homes: string[] = [];
const running: { stop: AbortController; done: Promise<unknown> }[] = [];
const quiet = () => [spyOn(console, 'log'), spyOn(console, 'error')];
let spies: ReturnType<typeof quiet> = [];
afterEach(async () => {
  for (const { stop, done } of running.splice(0)) {
    stop.abort();
    await done.catch(() => {});
  }
  await waitFor(() => presenters.size === 0);
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  tokens.clear();
  described.clear();
  frames.length = 0;
  upgrades = 0;
});

/** A KCP home holding the Signets given, each described by the loopback Kingdom with its channels. */
const kcpHome = async (
  ...signets: { signetId: string; eventChannels?: EventChannelMap; unowned?: boolean }[]
) => {
  const home = await mkdtemp(join(tmpdir(), 'kcp-listen-'));
  homes.push(home);
  for (const { signetId, eventChannels, unowned } of signets) {
    await holdSignet(home, url, {
      signetId,
      accessToken: accessToken(signetId),
      ...(unowned ? {} : { owner: orgOwner(tribe) }),
    });
    tokens.set(accessToken(signetId), signetId);
    described.set(signetId, {
      ...description({ signetId, resources: [] }),
      ...(eventChannels ? { eventChannels } : {}),
    });
  }
  return home;
};

/** Starts `listen`, collecting stdout lines (`out`) and stderr lines (`notes`). */
const start = (
  home: string,
  options: { selection?: Selection; json?: boolean; events?: string[] } = {},
) => {
  const out: string[] = [];
  const notes: string[] = [];
  const stop = new AbortController();
  const done = listen({
    home,
    url,
    selection: options.selection ?? {},
    json: options.json ?? true,
    events: options.events ?? [],
    out: (line) => void out.push(line),
    note: (line) => void notes.push(line),
    signal: stop.signal,
  });
  running.push({ stop, done });
  return { out, notes, stop, done };
};

describe('kcp listen', () => {
  test('an event is printed once as NDJSON; a gap goes to stderr and its event is still printed', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    const { out, notes, stop, done } = start(home, { events: ['events.Issue.*'] });
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    expect(out).toEqual([]);
    opened(linearSignet, engineering);
    await waitFor(() => notes.some((note) => note.startsWith('Listening on linear Engineering')));

    appended(linearSignet, engineering, seeded + 1, issue('delivery-1', 'Fix login'));
    await waitFor(() => out.length === 1);
    expect(JSON.parse(out[0] ?? '')).toEqual({
      signetId: linearSignet,
      integrationId: id(1),
      provider: 'linear',
      resourceId: engineering,
      resourceKind: 'team',
      resourceName: 'Engineering',
      eventId: 'delivery-1',
      type: 'Issue.create',
      seq: seeded + 1,
      event: { at: '2026-11-13T10:02:03.000Z', scope: 'ENG', subject: { title: 'Fix login' } },
    });
    expect(notes.some((note) => note.includes('Gap'))).toBe(false);

    appended(linearSignet, engineering, seeded + 5, issue('delivery-5', 'After the gap'));
    await waitFor(() => out.length === 2);
    expect(JSON.parse(out[1] ?? '')).toMatchObject({ eventId: 'delivery-5', seq: seeded + 5 });
    expect(notes.filter((note) => note.includes('Gap'))).toEqual([
      expect.stringMatching(
        new RegExp(`^Gap on linear Engineering .*: seq ${seeded + 1} to ${seeded + 5}`),
      ),
    ]);
    await settle();
    expect(out).toHaveLength(2);
    for (const line of out) expect(line).not.toContain('\n');

    stop.abort();
    expect(await done).toBe(0);
    await waitFor(() => presenters.size === 0);
    const printed = [...out, ...notes].join('\n');
    expect(printed).not.toContain(accessToken(linearSignet));
    expect(printed).not.toContain(credentials().renewalCredential);
    expect(printed).not.toContain('kingdom_');
  });

  test('without --json, one short line per event', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    const { out } = start(home, { json: false });
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    opened(linearSignet, engineering);
    appended(linearSignet, engineering, seeded + 1, issue('delivery-1', 'Fix login'));
    await waitFor(() => out.length === 1);
    expect(out).toEqual(['2026-11-13T10:02:03Z  linear  Engineering  Issue.create  Fix login']);
  });

  test('a channel closed as revoked is reported; when the last one ends the command exits non-zero', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    const { out, notes, done } = start(home);
    let code: number | null = null;
    void done.then((exit) => {
      code = exit;
    });
    await waitFor(
      () =>
        sent('open', linearSignet, engineering) === 1 && sent('open', linearSignet, design) === 1,
    );
    opened(linearSignet, engineering);
    opened(linearSignet, design);
    closedBy(linearSignet, engineering, 'revoked');
    await waitFor(() => notes.some((note) => note.includes('revoked')));
    expect(notes).toContainEqual(
      expect.stringMatching(/^Stopped listening on linear Engineering .*: revoked$/),
    );
    appended(linearSignet, design, seeded + 1, {
      eventId: 'comment-1',
      type: 'Comment.create',
      event: {},
    });
    await waitFor(() => out.length === 1);
    expect(code).toBeNull();

    closedBy(linearSignet, design, 'expired');
    expect(await done).toBe(1);
    expect(notes).toContainEqual(
      expect.stringMatching(/^Stopped listening on linear Design .*: expired$/),
    );
    expect(notes.at(-1)).toMatch(/Every channel ended/);
    await waitFor(() => presenters.size === 0);
    expect(out).toHaveLength(1);
  });

  test('a channel Kingdom reopens says so: what was published meanwhile is gone', async () => {
    const home = await kcpHome({ signetId: slackSignet, eventChannels: slackChannels });
    const { notes } = start(home);
    await waitFor(() => sent('open', slackSignet, general) === 1);
    opened(slackSignet, general);
    await waitFor(() => notes.some((note) => note.startsWith('Listening on slack general')));
    closedBy(slackSignet, general, 'revised');
    await waitFor(() => sent('open', slackSignet, general) === 2);
    opened(slackSignet, general, seeded + 9);
    await waitFor(() => notes.some((note) => note.startsWith('Listening again on slack general')));
    expect(notes.some((note) => note.startsWith('Stopped listening'))).toBe(false);
  });

  test('a secret in an error never reaches stderr', async () => {
    const home = await kcpHome({ signetId: slackSignet, eventChannels: slackChannels });
    const notes: string[] = [];
    const stop = new AbortController();
    const done = listen({
      home,
      url,
      selection: {},
      out: () => {
        throw Error(`stdout closed while holding ${accessToken(slackSignet)}`);
      },
      note: (line) => void notes.push(line),
      signal: stop.signal,
    });
    running.push({ stop, done });
    await waitFor(() => sent('open', slackSignet, general) === 1);
    opened(slackSignet, general);
    appended(slackSignet, general, seeded + 1, {
      eventId: 'message-1',
      type: 'message.channels',
      event: {},
    });
    await waitFor(() => notes.some((note) => note.includes('stdout closed')));
    expect(notes.find((note) => note.includes('stdout closed'))).toBe(
      `Signet ${slackSignet}: stdout closed while holding kingdom_REDACTED`,
    );
  });

  test('a refused open ends that channel too', async () => {
    const home = await kcpHome({ signetId: slackSignet, eventChannels: slackChannels });
    const { notes, done } = start(home);
    await waitFor(() => sent('open', slackSignet, general) === 1);
    toHolder(slackSignet, {
      type: 'openRejected',
      stream: stream(slackSignet, general),
      reason: 'unauthorized',
    });
    expect(await done).toBe(1);
    expect(notes).toContainEqual(
      expect.stringMatching(/^Stopped listening on slack general .*: unauthorized$/),
    );
  });

  test('--event keeps the channels holding an event it admits, and only their Signets connect', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, eventChannels: slackChannels },
    );
    start(home, { events: ['events.Issue.create'] });
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    await settle();
    expect(frames.filter((frame) => frame.action === 'open')).toHaveLength(1);
    expect([...presenters.keys()]).toEqual([linearSignet]);
    expect(upgrades).toBe(1);
  });

  test('--event as a prefix, across Signets', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, eventChannels: slackChannels },
    );
    start(home, { events: ['events.message.*', 'events.Comment.*'] });
    await waitFor(
      () => sent('open', linearSignet, design) === 1 && sent('open', slackSignet, general) === 1,
    );
    await settle();
    expect(sent('open', linearSignet, engineering)).toBe(0);
    expect(frames.filter((frame) => frame.action === 'open')).toHaveLength(2);
  });

  test('with no selector every held Signet listens; --signet and -i choose among them', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, eventChannels: slackChannels },
    );
    const all = start(home);
    await waitFor(() => frames.filter((frame) => frame.action === 'open').length === 3);
    expect([...presenters.keys()].sort()).toEqual([linearSignet, slackSignet]);
    all.stop.abort();
    await all.done;
    await waitFor(() => presenters.size === 0);
    frames.length = 0;

    const one = start(home, { selection: { signetId: slackSignet } });
    await waitFor(() => sent('open', slackSignet, general) === 1);
    await settle();
    expect([...presenters.keys()]).toEqual([slackSignet]);
    one.stop.abort();
    await one.done;
    await waitFor(() => presenters.size === 0);
    frames.length = 0;

    start(home, { selection: { integrationId: id(1) } });
    await waitFor(() => frames.filter((frame) => frame.action === 'open').length === 2);
    await settle();
    expect([...presenters.keys()]).toEqual([linearSignet]);
  });

  test('nothing to listen on exits non-zero, says why, and never opens a socket', async () => {
    const none = await kcpHome();
    await expect(start(none).done).rejects.toThrow(/holds no Signet/);

    const silent = await kcpHome(
      { signetId: linearSignet, eventChannels: [] },
      // A Kingdom before integration events sends no `eventChannels` at all.
      { signetId: slackSignet },
    );
    await expect(start(silent).done).rejects.toThrow(
      /None of the 2 held Signets has an event channel/,
    );

    const filtered = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    await expect(start(filtered, { events: ['events.pull_request.*'] }).done).rejects.toThrow(
      /No event channel .* admits --event events\.pull_request\.\*.*events\.Comment\.create, events\.Issue\.create, events\.Issue\.update/s,
    );
    await expect(
      start(filtered, {
        selection: { owner: { ownerModel: 'Organization', organizationId: id(999) } },
      }).done,
    ).rejects.toThrow(/holds no Signet for Organization/);
    await expect(start(filtered, { selection: { signetId: id(99) } }).done).rejects.toThrow(
      `kcp login --signet ${id(99)}`,
    );
    expect(upgrades).toBe(0);
  });

  test('a Signet Kingdom no longer describes is left out, and said so', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, eventChannels: slackChannels },
    );
    described.delete(slackSignet);
    const { notes } = start(home);
    await waitFor(() => frames.filter((frame) => frame.action === 'open').length === 2);
    expect(notes).toContainEqual(
      expect.stringMatching(new RegExp(`^Left out Signet ${slackSignet}: revoked`)),
    );
    expect([...presenters.keys()]).toEqual([linearSignet]);
  });
});

describe('heldListeners', () => {
  test('each described Signet with the integrations it has channels on, and its recorded owner', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, unowned: true },
    );
    const { listeners, unread } = await heldListeners(home, url);
    expect(unread).toEqual([]);
    expect(listeners).toMatchObject([
      {
        signetId: linearSignet,
        owner: orgOwner(tribe),
        integrations: [
          {
            integrationId: id(1),
            provider: 'linear',
            name: 'Tribe Linear',
            channels: linearChannels[0]?.channels,
          },
        ],
      },
      { signetId: slackSignet, owner: null, integrations: [] },
    ]);
  });
});

describe('kcp [selectors] listen', () => {
  const env = (home: string) => ({ KCP_HOME: home, KINGDOM_URL: url });
  const said = (spy: ReturnType<typeof quiet>[number] | undefined) =>
    (spy?.mock.calls ?? []).map((call) => String(call[0]));

  test('usage names the command', () => {
    expect(usage).toContain('kcp [selectors] listen [--json] [--event LEAF|PREFIX.*]…');
  });

  test('prints events on stdout and everything else on stderr, until interrupted', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, eventChannels: slackChannels },
    );
    spies = quiet();
    for (const spy of spies) spy.mockImplementation(() => {});
    const [log, error] = spies;
    const stop = new AbortController();
    const done = main(
      ['--signet', linearSignet, 'listen', '--json', '--event', 'events.Issue.*'],
      env(home),
      undefined,
      stop.signal,
    );
    running.push({ stop, done });
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    opened(linearSignet, engineering);
    appended(linearSignet, engineering, seeded + 1, issue('delivery-1', 'Fix login'));
    await waitFor(() => said(log).length === 1);
    expect(JSON.parse(said(log)[0] ?? '')).toMatchObject({
      signetId: linearSignet,
      eventId: 'delivery-1',
      seq: seeded + 1,
    });
    expect(said(error).some((line) => line.startsWith('Listening on linear Engineering'))).toBe(
      true,
    );
    expect(frames.filter((frame) => frame.action === 'open')).toHaveLength(1);
    stop.abort();
    expect(await done).toBe(0);
  });

  test('refuses a filter that is no event leaf, and flags it does not know, before any call', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    described.clear();
    await expect(main(['listen', '--event', 'Issue.create'], env(home))).rejects.toThrow(
      /--event takes an event leaf/,
    );
    await expect(main(['listen', '--bogus'], env(home))).rejects.toThrow();
    await expect(main(['--json', 'listen'], env(home))).rejects.toThrow(/Unknown selector --json/);
    expect(upgrades).toBe(0);
  });

  test('as a process: SIGINT closes the sockets and exits 0, with only events on stdout', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    const kcp = Bun.spawn(
      [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), 'listen', '--json'],
      { env: { ...process.env, ...env(home) }, stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      await waitFor(() => sent('open', linearSignet, engineering) === 1, 10_000);
      opened(linearSignet, engineering);
      appended(linearSignet, engineering, seeded + 1, issue('delivery-1', 'Fix login'));
      const reader = kcp.stdout.getReader();
      let stdout = '';
      while (!stdout.includes('\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += new TextDecoder().decode(value);
      }
      kcp.kill('SIGINT');
      expect(await kcp.exited).toBe(0);
      const stderr = await new Response(kcp.stderr).text();
      expect(stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({ eventId: 'delivery-1', resourceId: engineering });
      expect(stderr).toContain('Listening on linear Engineering');
      expect(stdout + stderr).not.toContain('kingdom_');
      await waitFor(() => presenters.size === 0);
    } finally {
      kcp.kill();
    }
  }, 20_000);
});
