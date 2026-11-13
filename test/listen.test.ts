import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installationPaths, writePrivateJson } from '@inixiative/signet';
import { accessEventsStreamName, type EventChannelMap } from '@inixiative/signet/contracts';
import type { ServerWebSocket } from 'bun';
import { main, usage } from '../src/cli';
import { heldListeners, listen } from '../src/listen';
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
/** Signet ids in the order Kingdom was asked to describe them. */
const describes: string[] = [];
/** Times a paired installation asked for its Signets (`installationSignets`). */
let syncs = 0;
/** Requests the client gave up on before Kingdom answered. */
let abandoned = 0;
/** While set, Kingdom refuses every WebSocket upgrade: nothing ever connects. */
let refuseUpgrades = false;
/** While set, Kingdom answers no `describe` or `installationSignets` until it settles. */
let withheld: PromiseWithResolvers<void> | null = null;
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
        return !refuseUpgrades && server.upgrade(request, { data: { signetId: null } })
          ? undefined
          : new Response(null, { status: 426 });
      }
      const action = new URL(request.url).pathname.split('/').at(-1);
      if (action === 'nonce') return Response.json({ data: { nonce: token43('n') } });
      if (action === 'describe' || action === 'installationSignets') {
        const { signetId } = (await request.json()) as { signetId: string };
        if (action === 'describe') describes.push(signetId);
        else syncs++;
        if (withheld) {
          request.signal.addEventListener('abort', () => abandoned++);
          await withheld.promise;
        }
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
  describes.length = 0;
  upgrades = 0;
  syncs = 0;
  abandoned = 0;
  refuseUpgrades = false;
  withheld?.resolve();
  withheld = null;
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

type ListenInput = Parameters<typeof listen>[0];

/**
 * Starts `listen`, collecting stdout lines (`out`) and stderr lines (`notes`). The waits a person
 * would sit through (a stalled channel, a retried presentation, the pause before a Signet is
 * described again) are milliseconds here.
 */
const start = (
  home: string,
  options: Partial<Omit<ListenInput, 'home' | 'url' | 'note' | 'signal'>> = {},
) => {
  const out: string[] = [];
  const notes: string[] = [];
  const stop = new AbortController();
  const done = listen({
    home,
    url,
    selection: {},
    json: true,
    events: [],
    out: (line) => void out.push(line),
    rereadMs: 10,
    socket: { retryBaseMs: 5, retryMaxMs: 20 },
    ...options,
    note: (line) => void notes.push(line),
    signal: stop.signal,
  });
  running.push({ stop, done });
  return { out, notes, stop, done };
};

/** Everything `terminalSafe` strips, and what any line-reader takes for a line break. */
const unprintable = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
const lineBreak = /\r\n|[\n\v\f\r\x85\u2028\u2029]/;
const exitOf = (done: Promise<number>) => {
  const exit: { code: number | null } = { code: null };
  void done.then((code) => {
    exit.code = code;
  });
  return exit;
};
const describedTimes = (signetId: string) => describes.filter((id) => id === signetId).length;
/** Kingdom revises a Signet: it describes it anew, and closes each open channel as `revised`. */
const revise = (signetId: string, eventChannels: EventChannelMap, ...open: string[]) => {
  described.set(signetId, { ...description({ signetId, resources: [] }), eventChannels });
  for (const resourceId of open) closedBy(signetId, resourceId, 'revised');
};
const linearWith = (...channels: EventChannelMap[number]['channels']): EventChannelMap => [
  { integration: { id: id(1), provider: 'linear', name: 'Tribe Linear' }, channels },
];
const team = (resourceId: string, name: string, ...events: string[]) =>
  eventChannel(linearSignet, resourceId, { kind: 'team', name, events });

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
    const { notes, done } = start(home, {
      out: () => {
        throw Error(`stdout closed while holding ${accessToken(slackSignet)}`);
      },
    });
    await waitFor(() => sent('open', slackSignet, general) === 1);
    opened(slackSignet, general);
    appended(slackSignet, general, seeded + 1, {
      eventId: 'message-1',
      type: 'message.channels',
      event: {},
    });
    expect(await done).toBe(0);
    expect(notes.at(-1)).toBe(
      'Stopped: stdout could not be written (stdout closed while holding kingdom_REDACTED)',
    );
  });

  test('provider text never reaches the terminal raw: one clean line per event, one per note', async () => {
    const hostileName = 'Engi\nneering\x1b[2K\u202e';
    const hostileTitle = 'Fix\x1b[1A\x1b[2K login\x07\x00\u009b31m \u202egnp.exe';
    const hostile = {
      eventId: 'delivery-1',
      type: 'Issue.create\r\nIssue.delete',
      event: { at: '2026-11-13T10:02:03.000Z', subject: { title: hostileTitle } },
    };
    const home = await kcpHome({
      signetId: linearSignet,
      eventChannels: linearWith(team(engineering, hostileName, 'events.Issue.create')),
    });
    const human = start(home, { json: false });
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    opened(linearSignet, engineering);
    appended(linearSignet, engineering, seeded + 1, hostile);
    appended(linearSignet, engineering, seeded + 9, hostile);
    await waitFor(() => human.out.length === 2);
    expect(human.out[0]).toBe(
      '2026-11-13T10:02:03Z  linear  Engi neering[2K  Issue.create Issue.delete  Fix[1A[2K login31m gnp.exe',
    );
    for (const line of [...human.out, ...human.notes]) {
      expect(line).not.toMatch(unprintable);
      expect(line.split(lineBreak)).toHaveLength(1);
    }
    expect(human.notes.filter((note) => note.includes('neering'))).toEqual([
      expect.stringMatching(/^Listening on linear Engi neering\[2K \(team /),
      expect.stringMatching(/^Gap on linear Engi neering\[2K \(team /),
    ]);
    human.stop.abort();
    await human.done;
    await waitFor(() => presenters.size === 0);
    frames.length = 0;

    const json = start(home);
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    opened(linearSignet, engineering);
    appended(linearSignet, engineering, seeded + 1, hostile);
    await waitFor(() => json.out.length === 1);
    const [line = ''] = json.out;
    expect(line).not.toMatch(unprintable);
    expect(line.split(lineBreak)).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      resourceName: hostileName,
      type: hostile.type,
      event: { subject: { title: hostileTitle } },
    });
  });

  test('an error is one clean line on stderr, whatever Kingdom put in the frame', async () => {
    const home = await kcpHome({ signetId: slackSignet, eventChannels: slackChannels });
    const { notes } = start(home);
    await waitFor(() => sent('open', slackSignet, general) === 1);
    opened(slackSignet, general);
    toHolder(slackSignet, {
      category: 'data',
      action: 'append',
      stream: stream(slackSignet, general),
      seq: seeded + 1,
      type: 'app\nend\x1b[2K\u202e',
      payload: {},
    });
    await waitFor(() => notes.some((note) => note.includes('unreadable')));
    expect(notes.at(-1)).toBe(
      `Signet ${slackSignet}: ${stream(slackSignet, general)}: unreadable app end[2K append`,
    );
  });

  test('when stdout can no longer be written the command stops: sockets closed, exit 0', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, eventChannels: slackChannels },
    );
    const written: string[] = [];
    const { notes, done } = start(home, {
      out: async (line) => {
        if (written.length === 1)
          throw Object.assign(Error('EPIPE: broken pipe, write'), { code: 'EPIPE' });
        written.push(line);
      },
    });
    await waitFor(() => frames.filter((frame) => frame.action === 'open').length === 3);
    opened(linearSignet, engineering);
    opened(slackSignet, general);
    appended(linearSignet, engineering, seeded + 1, issue('delivery-1', 'Read'));
    await waitFor(() => written.length === 1);
    expect(presenters.size).toBe(2);
    appended(linearSignet, engineering, seeded + 2, issue('delivery-2', 'Nobody reads this'));
    expect(await done).toBe(0);
    await waitFor(() => presenters.size === 0);
    expect(written).toHaveLength(1);
    expect(notes.some((note) => /EPIPE|stdout/.test(note))).toBe(false);
  });

  test('--event prints only the kinds it admits, on a channel that delivers more', async () => {
    const home = await kcpHome({
      signetId: linearSignet,
      eventChannels: linearWith(
        team(engineering, 'Engineering', 'events.Issue.create', 'events.Comment.create'),
      ),
    });
    const { out } = start(home, { events: ['events.Issue.create'] });
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    opened(linearSignet, engineering);
    appended(linearSignet, engineering, seeded + 1, {
      eventId: 'comment-1',
      type: 'Comment.create',
      event: {},
    });
    appended(linearSignet, engineering, seeded + 2, issue('delivery-2', 'Fix login'));
    await waitFor(() => out.length > 0);
    await settle();
    expect(out.map((line) => JSON.parse(line).eventId)).toEqual(['delivery-2']);
  });

  test('when the last channel of one Signet ends its socket closes; the others keep listening', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, eventChannels: slackChannels },
    );
    const { out, done } = start(home);
    const exit = exitOf(done);
    await waitFor(() => frames.filter((frame) => frame.action === 'open').length === 3);
    opened(linearSignet, engineering);
    opened(slackSignet, general);
    closedBy(slackSignet, general, 'revoked');
    await waitFor(() => !presenters.has(slackSignet));
    expect(presenters.has(linearSignet)).toBe(true);
    appended(linearSignet, engineering, seeded + 1, issue('delivery-1', 'Still heard'));
    await waitFor(() => out.length === 1);
    expect(exit.code).toBeNull();
  });

  test('after an interrupt nothing more is printed, even an event that had already arrived', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    const written: string[] = [];
    const writing = Promise.withResolvers<void>();
    const { notes, stop, done } = start(home, {
      out: async (line) => {
        written.push(line);
        await writing.promise;
      },
    });
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    opened(linearSignet, engineering);
    appended(linearSignet, engineering, seeded + 1, issue('delivery-1', 'Being written'));
    appended(
      linearSignet,
      engineering,
      seeded + 2,
      issue('delivery-2', 'Arrived, not yet written'),
    );
    await waitFor(() => written.length === 1);
    await settle();
    stop.abort();
    expect(await done).toBe(0);
    const noted = notes.length;
    writing.resolve();
    await settle();
    expect(written).toHaveLength(1);
    expect(notes).toHaveLength(noted);
  });

  test('a Signet that never connects says so after the wait, naming the channel, then less often', async () => {
    const home = await kcpHome({ signetId: slackSignet, eventChannels: slackChannels });
    refuseUpgrades = true;
    const { notes, done } = start(home, { stallMs: 40 });
    const exit = exitOf(done);
    const stalls = () => notes.filter((note) => note.startsWith('Still not listening'));
    await waitFor(() => stalls().length === 2);
    expect(stalls()[0]).toMatch(
      new RegExp(
        `^Still not listening on slack general \\(channel ${general}, Signet ${slackSignet}\\) after \\d+ ms: no connection to Kingdom yet$`,
      ),
    );
    const waited = stalls().map((note) => Number(/after (\d+) ms/.exec(note)?.[1]));
    expect(waited[0]).toBeGreaterThanOrEqual(40);
    expect(waited[1]).toBeGreaterThanOrEqual(120);
    expect(upgrades).toBeGreaterThan(1);
    expect(exit.code).toBeNull();
  });

  test('a Kingdom that accepts the Signet and never opens a channel is said so, until it opens', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    const { notes } = start(home, { stallMs: 100 });
    const stalls = (name: string) =>
      notes.filter((note) => note.startsWith(`Still not listening on linear ${name}`));
    await waitFor(() => sent('open', linearSignet, design) === 1);
    opened(linearSignet, design);
    await waitFor(() => stalls('Engineering').length === 1);
    expect(stalls('Engineering')[0]).toMatch(
      /after \d+ ms: Kingdom accepted the Signet and has not opened the channel$/,
    );
    expect(stalls('Design')).toEqual([]);
    opened(linearSignet, engineering);
    await waitFor(() => notes.some((note) => note.startsWith('Listening on linear Engineering')));
    await Bun.sleep(350);
    expect(stalls('Engineering')).toHaveLength(1);
  });

  test('a connection that drops and does not come back is said the same way', async () => {
    const home = await kcpHome({ signetId: slackSignet, eventChannels: slackChannels });
    const { notes } = start(home, { stallMs: 40 });
    await waitFor(() => sent('open', slackSignet, general) === 1);
    opened(slackSignet, general);
    await waitFor(() => notes.some((note) => note.startsWith('Listening on slack general')));
    refuseUpgrades = true;
    presenters.get(slackSignet)?.close();
    await waitFor(() => notes.some((note) => note.startsWith('Still not listening')));
    expect(notes.at(-1)).toMatch(
      /^Still not listening on slack general .* after \d+ ms: no connection to Kingdom yet$/,
    );
    refuseUpgrades = false;
    await waitFor(() => sent('open', slackSignet, general) === 2);
    opened(slackSignet, general);
    await waitFor(() => notes.some((note) => note.startsWith('Listening again on slack general')));
  });

  test('a Signet Kingdom keeps refusing, that never listened, ends once nothing else is left', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, eventChannels: slackChannels },
    );
    tokens.delete(accessToken(slackSignet));
    const { notes, done } = start(home, { refusalLimit: 3, stallMs: 40 });
    const exit = exitOf(done);
    const refusals = () =>
      notes.filter(
        (note) => note === `Signet ${slackSignet}: Kingdom refused this Signet presentation`,
      );
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    opened(linearSignet, engineering);
    opened(linearSignet, design);
    await waitFor(() => refusals().length >= 5);
    await waitFor(() =>
      notes.some((note) =>
        /^Still not listening on slack general .*: Kingdom refused the Signet's presentation, \d+ times running$/.test(
          note,
        ),
      ),
    );
    expect(exit.code).toBeNull();

    closedBy(linearSignet, engineering, 'revoked');
    closedBy(linearSignet, design, 'revoked');
    expect(await done).toBe(1);
    expect(notes.slice(-2)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Gave up on Signet ${slackSignet}: Kingdom refused its presentation \\d+ times running and none of its channels ever opened`,
        ),
      ),
      'Every channel ended; nothing is left to listen on',
    ]);
    await waitFor(() => presenters.size === 0);
    const upgraded = upgrades;
    await Bun.sleep(60);
    expect(upgrades).toBe(upgraded);
  });

  test('refused alone: the command gives up at the limit, not before', async () => {
    const home = await kcpHome({ signetId: slackSignet, eventChannels: slackChannels });
    tokens.delete(accessToken(slackSignet));
    const { notes, done } = start(home, { refusalLimit: 4 });
    expect(await done).toBe(1);
    expect(
      notes.filter((note) => note.endsWith('Kingdom refused this Signet presentation')),
    ).toHaveLength(4);
    expect(notes.at(-2)).toMatch(/^Gave up on Signet .* 4 times running/);
  });

  test('a revision that adds a channel opens it, with one describe however many channels reopen', async () => {
    const both = [
      team(engineering, 'Engineering', 'events.Issue.create'),
      team(design, 'Design', 'events.Comment.create'),
    ];
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearWith(...both) });
    const { out, notes } = start(home, { rereadMs: 50 });
    await waitFor(
      () =>
        sent('open', linearSignet, engineering) === 1 && sent('open', linearSignet, design) === 1,
    );
    opened(linearSignet, engineering);
    opened(linearSignet, design);
    await waitFor(() => notes.filter((note) => note.startsWith('Listening on')).length === 2);
    await settle();
    expect(describedTimes(linearSignet)).toBe(1);

    revise(
      linearSignet,
      linearWith(...both, team(general, 'Platform', 'events.Issue.create')),
      engineering,
      design,
    );
    await waitFor(
      () =>
        sent('open', linearSignet, engineering) === 2 && sent('open', linearSignet, design) === 2,
    );
    opened(linearSignet, engineering);
    opened(linearSignet, design);
    await waitFor(() => sent('open', linearSignet, general) === 1);
    opened(linearSignet, general);
    await waitFor(() => notes.some((note) => note.startsWith('Listening on linear Platform')));
    appended(linearSignet, general, seeded + 1, issue('delivery-1', 'On the new channel'));
    await waitFor(() => out.length === 1);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      resourceId: general,
      resourceName: 'Platform',
    });
    await settle();
    expect(describedTimes(linearSignet)).toBe(2);
  });

  test('a revision that removes the last kind --event admits on a channel leaves it, and says so', async () => {
    const home = await kcpHome({
      signetId: linearSignet,
      eventChannels: linearWith(
        team(engineering, 'Engineering', 'events.Issue.create', 'events.Comment.create'),
        team(design, 'Design', 'events.Issue.update'),
        team(general, 'Sales', 'events.Issue.create'),
      ),
    });
    const { out, notes, done } = start(home, { events: ['events.Issue.*'] });
    const exit = exitOf(done);
    await waitFor(() => frames.filter((frame) => frame.action === 'open').length === 3);
    for (const resource of [engineering, design, general]) opened(linearSignet, resource);
    await waitFor(() => notes.filter((note) => note.startsWith('Listening on')).length === 3);

    revise(
      linearSignet,
      linearWith(
        team(engineering, 'Engineering', 'events.Comment.create'),
        team(design, 'Design', 'events.Issue.update'),
      ),
      engineering,
      design,
    );
    await waitFor(
      () =>
        sent('open', linearSignet, engineering) === 2 && sent('open', linearSignet, design) === 2,
    );
    opened(linearSignet, engineering);
    opened(linearSignet, design);
    await waitFor(() => notes.filter((note) => note.startsWith('Left ')).length === 2);
    expect(notes.filter((note) => note.startsWith('Left '))).toEqual([
      `Left linear Engineering (team ${engineering}, Signet ${linearSignet}): it no longer holds an event --event events.Issue.* admits`,
      `Left linear Sales (team ${general}, Signet ${linearSignet}): the Signet no longer holds it`,
    ]);
    await waitFor(
      () =>
        sent('close', linearSignet, engineering) === 1 &&
        sent('close', linearSignet, general) === 1,
    );
    expect(sent('close', linearSignet, design)).toBe(0);
    appended(linearSignet, engineering, seeded + 1, issue('delivery-1', 'Left behind'));
    appended(linearSignet, design, seeded + 1, {
      eventId: 'delivery-2',
      type: 'Issue.update',
      event: {},
    });
    await waitFor(() => out.length > 0);
    await settle();
    expect(out.map((line) => JSON.parse(line).eventId)).toEqual(['delivery-2']);
    expect(exit.code).toBeNull();
  });

  test('a resource a revision renamed prints under its new name', async () => {
    const home = await kcpHome({
      signetId: linearSignet,
      eventChannels: linearWith(team(engineering, 'Engineering', 'events.Issue.create')),
    });
    const { out, notes } = start(home, { json: false });
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    opened(linearSignet, engineering);
    await waitFor(() => notes.some((note) => note.startsWith('Listening on linear Engineering')));
    revise(
      linearSignet,
      linearWith(team(engineering, 'Platform', 'events.Issue.create')),
      engineering,
    );
    await waitFor(() => sent('open', linearSignet, engineering) === 2);
    opened(linearSignet, engineering, seeded + 5);
    await waitFor(() => describedTimes(linearSignet) === 2);
    await settle();
    appended(linearSignet, engineering, seeded + 9, issue('delivery-1', 'Fix login'));
    await waitFor(() => out.length === 1);
    expect(out).toEqual(['2026-11-13T10:02:03Z  linear  Platform  Issue.create  Fix login']);
    expect(notes.at(-1)).toMatch(new RegExp(`^Gap on linear Platform \\(team ${engineering}, `));
  });

  test('a Signet Kingdom does not describe after a reopen keeps its channels, and says so', async () => {
    const home = await kcpHome({ signetId: slackSignet, eventChannels: slackChannels });
    const { out, notes } = start(home);
    await waitFor(() => sent('open', slackSignet, general) === 1);
    opened(slackSignet, general);
    await waitFor(() => notes.some((note) => note.startsWith('Listening on slack general')));
    described.delete(slackSignet);
    closedBy(slackSignet, general, 'revised');
    await waitFor(() => sent('open', slackSignet, general) === 2);
    opened(slackSignet, general);
    await waitFor(() => notes.some((note) => note.includes('did not describe it')));
    expect(notes.at(-1)).toBe(
      `Signet ${slackSignet}: Kingdom did not describe it after a channel reopened; its channels and their names stay as they were`,
    );
    appended(slackSignet, general, seeded + 1, {
      eventId: 'message-1',
      type: 'message.channels',
      event: {},
    });
    await waitFor(() => out.length === 1);
  });

  test('a reconnect describes the Signet again too', async () => {
    const home = await kcpHome({
      signetId: linearSignet,
      eventChannels: linearWith(team(engineering, 'Engineering', 'events.Issue.create')),
    });
    const { notes } = start(home);
    await waitFor(() => sent('open', linearSignet, engineering) === 1);
    opened(linearSignet, engineering);
    await waitFor(() => notes.some((note) => note.startsWith('Listening on linear Engineering')));
    described.set(linearSignet, {
      ...description({ signetId: linearSignet, resources: [] }),
      eventChannels: linearWith(
        team(engineering, 'Engineering', 'events.Issue.create'),
        team(design, 'Design', 'events.Issue.create'),
      ),
    });
    presenters.get(linearSignet)?.close();
    await waitFor(() => sent('open', linearSignet, engineering) === 2);
    opened(linearSignet, engineering);
    await waitFor(() => sent('open', linearSignet, design) === 1);
  });

  test('an interrupt while Kingdom is still describing the Signets exits 0 at once and abandons the read', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    withheld = Promise.withResolvers<void>();
    const { notes, stop, done } = start(home);
    await waitFor(() => describedTimes(linearSignet) === 1);
    const began = Date.now();
    stop.abort();
    expect(await done).toBe(0);
    expect(Date.now() - began).toBeLessThan(1000);
    await waitFor(() => abandoned === 1);
    expect(notes).toEqual([]);
    expect(upgrades).toBe(0);
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

  test('an interrupt while a paired installation is still syncing its Signets exits 0 at once too', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    await writePrivateJson(join(installationPaths(home, url).directory, 'installation.json'), {
      integrationId: id(7),
      signetId: linearSignet,
      owner: orgOwner(tribe),
    });
    withheld = Promise.withResolvers<void>();
    const { stop, done } = start(home);
    await waitFor(() => syncs === 1);
    stop.abort();
    expect(await done).toBe(0);
    await waitFor(() => abandoned === 1);
    expect(describes).toEqual([]);
  });

  test('--signet naming a held Signet Kingdom refuses says Kingdom refused it', async () => {
    const home = await kcpHome(
      { signetId: linearSignet, eventChannels: linearChannels },
      { signetId: slackSignet, eventChannels: slackChannels },
    );
    described.delete(slackSignet);
    const { notes, done } = start(home, { selection: { signetId: slackSignet } });
    await expect(done).rejects.toThrow(
      `Kingdom refused Signet ${slackSignet}: it is revoked, or this machine is no longer enrolled on it (kcp status)`,
    );
    expect(notes).toEqual([]);
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
    const lines: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string,
      written: () => void,
    ) => {
      lines.push(chunk);
      written();
      return true;
    }) as typeof process.stdout.write);
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
    await waitFor(() => lines.length === 1);
    write.mockRestore();
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      signetId: linearSignet,
      eventId: 'delivery-1',
      seq: seeded + 1,
    });
    expect(said(log)).toEqual([]);
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
    await expect(main(['listen', '--bogus'], env(home))).rejects.toThrow(
      "Unknown option '--bogus'",
    );
    for (const filter of ['events.Issue.', 'events..create'])
      await expect(main(['listen', '--event', filter], env(home))).rejects.toThrow(
        `--event takes an event leaf (events.Issue.create) or a prefix ending .* (events.Issue.*), not "${filter}"`,
      );
    await expect(main(['--json', 'listen'], env(home))).rejects.toThrow(/Unknown selector --json/);
    expect(upgrades).toBe(0);
  });

  const kcpProcess = (home: string) =>
    Bun.spawn(
      [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), 'listen', '--json'],
      { env: { ...process.env, ...env(home) }, stdout: 'pipe', stderr: 'pipe' },
    );

  test('as a process: once the reader of stdout has gone (| head -1), the next event ends it with exit 0', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    const kcp = kcpProcess(home);
    try {
      await waitFor(() => sent('open', linearSignet, engineering) === 1, 10_000);
      opened(linearSignet, engineering);
      appended(linearSignet, engineering, seeded + 1, issue('delivery-1', 'Read'));
      const reader = kcp.stdout.getReader();
      let stdout = '';
      while (!stdout.includes('\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += new TextDecoder().decode(value);
      }
      expect(JSON.parse(stdout)).toMatchObject({ eventId: 'delivery-1' });
      await reader.cancel();
      appended(linearSignet, engineering, seeded + 2, issue('delivery-2', 'Nobody reads this'));
      expect(await kcp.exited).toBe(0);
      const stderr = await new Response(kcp.stderr).text();
      expect(stderr).toContain('Listening on linear Engineering');
      expect(stderr).not.toContain('EPIPE');
      await waitFor(() => presenters.size === 0);
    } finally {
      kcp.kill();
    }
  }, 20_000);

  test('as a process: one SIGINT while Kingdom is still describing the Signets exits 0 promptly', async () => {
    const home = await kcpHome({ signetId: linearSignet, eventChannels: linearChannels });
    withheld = Promise.withResolvers<void>();
    const kcp = kcpProcess(home);
    try {
      await waitFor(() => describedTimes(linearSignet) === 1, 10_000);
      const began = Date.now();
      kcp.kill('SIGINT');
      expect(await kcp.exited).toBe(0);
      expect(Date.now() - began).toBeLessThan(3000);
      expect(await new Response(kcp.stdout).text()).toBe('');
      expect(await new Response(kcp.stderr).text()).toBe('');
      expect(upgrades).toBe(0);
    } finally {
      kcp.kill();
    }
  }, 20_000);

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
