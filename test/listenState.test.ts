import { describe, expect, test } from 'bun:test';
import type { ListenChannel, ListenIntegration } from '../src/listening';
import {
  type ListenConfig,
  type ListenEffect,
  type ListenInput,
  type ListenState,
  listenStart,
  listenTransition,
} from '../src/listenState';
import { eventChannel, id } from './fixtures';

const linear = id(11);
const slack = id(12);
const engineering = id(21);
const design = id(22);
const general = id(23);
const channel = (
  signetId: string,
  resourceId: string,
  resourceName: string,
  ...events: string[]
): ListenChannel => ({
  signetId,
  integrationId: id(1),
  provider: 'linear',
  resourceId,
  resourceKind: 'team',
  resourceName,
  events,
});
const engineeringChannel = channel(linear, engineering, 'Engineering', 'events.Issue.create');
const designChannel = channel(linear, design, 'Design', 'events.Comment.create');
const generalChannel = channel(slack, general, 'general', 'events.message.channels');
const label = (held: ListenChannel) =>
  `linear ${held.resourceName} (team ${held.resourceId}, Signet ${held.signetId})`;

const config: ListenConfig = {
  filters: [],
  json: true,
  stallMs: 15_000,
  refusalLimit: 3,
  rereadMs: 3_000,
  maxUnflushed: 2,
};

/** Frozen all the way down: a transition that changed the state it was given would throw. */
const frozen = <Value>(value: Value): Value => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) frozen(inner);
  }
  return value;
};

/** Feeds the inputs in order: the state they end in, and every effect on the way. */
const feed = (state: ListenState, inputs: readonly ListenInput[], settings = config) => {
  const effects: ListenEffect[] = [];
  let current = state;
  for (const input of inputs) {
    const next = listenTransition(frozen(current), input, settings);
    current = next.state;
    effects.push(...next.effects);
  }
  return { state: current, effects };
};
const notes = (effects: readonly ListenEffect[]) =>
  effects.flatMap((effect) => (effect.type === 'note' ? [effect.line] : []));
const of = <Type extends ListenEffect['type']>(effects: readonly ListenEffect[], type: Type) =>
  effects.filter((effect): effect is Extract<ListenEffect, { type: Type }> => effect.type === type);

/** One Linear Signet with two channels and one Slack Signet with one, all asked for at 0. */
const started = () =>
  listenStart(
    [
      { signetId: linear, channels: [engineeringChannel, designChannel] },
      { signetId: slack, channels: [generalChannel] },
    ],
    0,
  );
const alone = () => listenStart([{ signetId: slack, channels: [generalChannel] }], 0).state;
/** The Slack Signet alone, presented and listening. */
const listening = () =>
  feed(alone(), [
    { type: 'presented', signetId: slack },
    { type: 'opened', signetId: slack, resourceId: general },
  ]).state;
const refused = (signetId: string): ListenInput => ({
  type: 'error',
  signetId,
  message: 'Kingdom refused this Signet presentation',
  refused: true,
});
const event = (resourceId: string, eventId: string, signetId = slack): ListenInput => ({
  type: 'event',
  signetId,
  resourceId,
  append: { eventId, type: 'message.channels', event: {} },
  seq: 1,
  received: new Date('2026-11-13T11:00:00.000Z'),
});
const signetOf = (state: ListenState, signetId: string) => {
  const signet = state.signets.find((held) => held.signetId === signetId);
  if (!signet) throw Error(`no Signet ${signetId}`);
  return signet;
};
const heldOf = (state: ListenState, signetId: string, resourceId: string) => {
  const held = signetOf(state, signetId).channels.find(
    ({ channel: { resourceId: held } }) => held === resourceId,
  );
  if (!held) throw Error(`no channel ${resourceId}`);
  return held;
};

describe('listenStart', () => {
  test('opens every channel, each waiting since the start, nothing connected or written', () => {
    const { state, effects } = started();
    expect(effects).toEqual([
      { type: 'open', signetId: linear, resourceId: engineering },
      { type: 'open', signetId: linear, resourceId: design },
      { type: 'open', signetId: slack, resourceId: general },
    ]);
    expect(state).toMatchObject({ unflushed: 0, dropped: 0, ended: null });
    for (const signet of state.signets) {
      expect(signet).toMatchObject({ connected: false, everListened: false, refusals: 0 });
      for (const held of signet.channels)
        expect(held).toMatchObject({ opened: false, waitingSince: 0, stallNotes: 0 });
    }
  });
});

describe('listenTransition: a channel opens, reopens and ends', () => {
  test('the first open is noted as listening; the next as listening again, and its Signet is read again', () => {
    const first = feed(started().state, [
      { type: 'opened', signetId: linear, resourceId: engineering },
    ]);
    expect(first.effects).toEqual([
      { type: 'note', line: `Listening on ${label(engineeringChannel)}` },
    ]);
    expect(heldOf(first.state, linear, engineering)).toMatchObject({
      opened: true,
      waitingSince: null,
    });
    const again = feed(first.state, [
      { type: 'opened', signetId: linear, resourceId: engineering },
    ]);
    expect(again.effects).toEqual([
      {
        type: 'note',
        line: `Listening again on ${label(engineeringChannel)}; events published meanwhile were not delivered`,
      },
      { type: 'rereadIn', signetId: linear, ms: 3_000 },
    ]);
  });

  test('a close that ends a channel is noted; the Signet keeps its socket while it has another', () => {
    const { state, effects } = feed(started().state, [
      { type: 'closed', signetId: linear, resourceId: engineering, reason: 'revoked', at: 5 },
    ]);
    expect(effects).toEqual([
      { type: 'note', line: `Stopped listening on ${label(engineeringChannel)}: revoked` },
    ]);
    expect(signetOf(state, linear).channels.map((held) => held.channel)).toEqual([designChannel]);
    expect(state.ended).toBeNull();
  });

  test('a close with no reason says Kingdom gave none', () => {
    const { effects } = feed(started().state, [
      { type: 'closed', signetId: linear, resourceId: design, reason: null, at: 5 },
    ]);
    expect(notes(effects)).toEqual([
      `Stopped listening on ${label(designChannel)}: Kingdom gave no reason`,
    ]);
  });

  test("a Signet's last channel ending closes its socket and cancels its re-read; the others go on", () => {
    const { state, effects } = feed(started().state, [
      { type: 'opened', signetId: slack, resourceId: general },
      { type: 'opened', signetId: slack, resourceId: general },
      { type: 'closed', signetId: slack, resourceId: general, reason: 'expired', at: 5 },
    ]);
    expect(effects.slice(-3)).toEqual([
      { type: 'note', line: `Stopped listening on ${label(generalChannel)}: expired` },
      { type: 'cancelReread', signetId: slack },
      { type: 'closeSocket', signetId: slack },
    ]);
    expect(signetOf(state, slack)).toMatchObject({ channels: [], rereadScheduled: false });
    expect(state.ended).toBeNull();
  });

  test('when the last channel of the last Signet ends, the command ends 1 and says so last', () => {
    const { state, effects } = feed(alone(), [
      { type: 'closed', signetId: slack, resourceId: general, reason: 'revoked', at: 5 },
    ]);
    expect(effects).toEqual([
      { type: 'note', line: `Stopped listening on ${label(generalChannel)}: revoked` },
      { type: 'closeSocket', signetId: slack },
      { type: 'note', line: 'Every channel ended; nothing is left to listen on' },
      { type: 'closeSocket', signetId: slack },
      { type: 'finish', code: 1 },
    ]);
    expect(state.ended).toBe(1);
  });

  test('a gap is noted, naming the channel and both ends of it', () => {
    const { effects } = feed(started().state, [
      { type: 'gap', signetId: linear, resourceId: engineering, after: 4, seq: 9 },
    ]);
    expect(notes(effects)).toEqual([
      `Gap on ${label(engineeringChannel)}: seq 4 to 9; events in between were lost, or Kingdom restarted its count`,
    ]);
  });

  test('what names a Signet or a channel it does not hold changes nothing', () => {
    const { state } = started();
    const inputs: ListenInput[] = [
      { type: 'opened', signetId: linear, resourceId: general },
      { type: 'closed', signetId: slack, resourceId: design, reason: 'revoked', at: 1 },
      { type: 'gap', signetId: id(99), resourceId: general, after: 1, seq: 5 },
      { type: 'presented', signetId: id(99) },
      { type: 'dropped', signetId: id(99), at: 1 },
      { type: 'rereadDue', signetId: id(99) },
      { type: 'described', signetId: id(99), integrations: [], at: 1 },
      event(engineering, 'not-its-channel'),
    ];
    expect(feed(state, inputs)).toEqual({ state, effects: [] });
  });
});

describe('listenTransition: waiting, and the notes that say so', () => {
  const stalls = (effects: readonly ListenEffect[]) =>
    notes(effects).filter((line) => line.startsWith('Still not listening'));
  const ticks = (from: number, to: number, stepMs = 1_000): ListenInput[] =>
    Array.from({ length: (to - from) / stepMs + 1 }, (_, step) => ({
      type: 'tick' as const,
      at: from + step * stepMs,
    }));

  test('a waiting channel is noted after the wait, then at a doubling interval, never on every tick', () => {
    const { effects, state } = feed(alone(), ticks(0, 110_000));
    expect(stalls(effects)).toEqual([
      `Still not listening on ${label(generalChannel)} after 15 s: no connection to Kingdom yet`,
      `Still not listening on ${label(generalChannel)} after 45 s: no connection to Kingdom yet`,
      `Still not listening on ${label(generalChannel)} after 105 s: no connection to Kingdom yet`,
    ]);
    expect(heldOf(state, slack, general).stallNotes).toBe(3);
  });

  test('a listening channel is never noted, however long it listens', () => {
    expect(feed(listening(), ticks(0, 600_000, 15_000)).effects).toEqual([]);
  });

  test('a dropped connection starts the wait, from when it dropped', () => {
    const dropped = feed(listening(), [{ type: 'dropped', signetId: slack, at: 100_000 }]);
    expect(dropped.effects).toEqual([]);
    expect(signetOf(dropped.state, slack).connected).toBe(false);
    expect(heldOf(dropped.state, slack, general).waitingSince).toBe(100_000);
    expect(stalls(feed(dropped.state, ticks(100_000, 114_000)).effects)).toEqual([]);
    expect(stalls(feed(dropped.state, [{ type: 'tick', at: 115_000 }]).effects)).toEqual([
      `Still not listening on ${label(generalChannel)} after 15 s: no connection to Kingdom yet`,
    ]);
  });

  test('a reconnect Kingdom never reopens the channel on is still waiting since the drop, and noted', () => {
    const reconnected = feed(listening(), [
      { type: 'dropped', signetId: slack, at: 100_000 },
      { type: 'presented', signetId: slack },
    ]);
    expect(heldOf(reconnected.state, slack, general).waitingSince).toBe(100_000);
    expect(stalls(feed(reconnected.state, [{ type: 'tick', at: 115_000 }]).effects)).toEqual([
      `Still not listening on ${label(generalChannel)} after 15 s: Kingdom accepted the Signet and has not opened the channel`,
    ]);
  });

  test('connection attempts that keep failing do not start the wait again', () => {
    const { state } = feed(alone(), [
      { type: 'dropped', signetId: slack, at: 5_000 },
      { type: 'dropped', signetId: slack, at: 10_000 },
    ]);
    expect(heldOf(state, slack, general).waitingSince).toBe(0);
    expect(stalls(feed(state, [{ type: 'tick', at: 15_000 }]).effects)).toHaveLength(1);
  });

  test('a close Kingdom reopens after (an offline host) keeps the channel and starts the wait, with the reason', () => {
    const closed = feed(listening(), [
      { type: 'closed', signetId: slack, resourceId: general, reason: 'hostOffline', at: 50_000 },
    ]);
    expect(closed.effects).toEqual([]);
    expect(closed.state.ended).toBeNull();
    expect(heldOf(closed.state, slack, general)).toMatchObject({
      opened: true,
      waitingSince: 50_000,
      closed: 'hostOffline',
    });
    expect(stalls(feed(closed.state, [{ type: 'tick', at: 65_000 }]).effects)).toEqual([
      `Still not listening on ${label(generalChannel)} after 15 s: Kingdom closed it (hostOffline) and has not opened it again`,
    ]);
    for (const reason of ['revised', 'presentationExpired'])
      expect(
        feed(listening(), [
          { type: 'closed', signetId: slack, resourceId: general, reason, at: 1 },
        ]),
      ).toMatchObject({ effects: [], state: { ended: null } });
  });

  test('opening ends the wait, and the next wait is counted and noted afresh', () => {
    const { state, effects } = feed(alone(), [
      ...ticks(0, 50_000),
      { type: 'presented', signetId: slack },
      { type: 'opened', signetId: slack, resourceId: general },
      ...ticks(51_000, 200_000),
      { type: 'closed', signetId: slack, resourceId: general, reason: 'hostOffline', at: 200_000 },
      ...ticks(200_000, 215_000),
    ]);
    expect(stalls(effects).map((line) => /after (\d+ s)/.exec(line)?.[1])).toEqual([
      '15 s',
      '45 s',
      '15 s',
    ]);
    expect(heldOf(state, slack, general)).toMatchObject({ waitingSince: 200_000, stallNotes: 1 });
  });

  test('a refused Signet says so, with how many times running', () => {
    const { effects } = feed(started().state, [
      { type: 'presented', signetId: linear },
      { type: 'opened', signetId: linear, resourceId: engineering },
      { type: 'opened', signetId: linear, resourceId: design },
      refused(slack),
      refused(slack),
      { type: 'tick', at: 15_000 },
    ]);
    expect(stalls(effects)).toEqual([
      `Still not listening on ${label(generalChannel)} after 15 s: Kingdom refused the Signet's presentation, 2 times running`,
    ]);
  });
});

describe('listenTransition: a refused Signet', () => {
  const gaveUp = (times: number) =>
    `Gave up on Signet ${slack}: Kingdom refused its presentation ${times} times running and none of its channels ever opened (kcp status)`;

  test('every error is noted; one that never listened is given up on at the limit, not before', () => {
    const two = feed(alone(), [refused(slack), refused(slack)]);
    expect(two.effects).toEqual([
      { type: 'note', line: `Signet ${slack}: Kingdom refused this Signet presentation` },
      { type: 'note', line: `Signet ${slack}: Kingdom refused this Signet presentation` },
    ]);
    expect(two.state.ended).toBeNull();
    const three = feed(two.state, [refused(slack)]);
    expect(three.effects).toEqual([
      { type: 'note', line: `Signet ${slack}: Kingdom refused this Signet presentation` },
      { type: 'note', line: gaveUp(3) },
      { type: 'note', line: 'Every channel ended; nothing is left to listen on' },
      { type: 'closeSocket', signetId: slack },
      { type: 'finish', code: 1 },
    ]);
    expect(three.state.ended).toBe(1);
  });

  test('an error that is no refusal is noted and never counted', () => {
    const down: ListenInput = {
      type: 'error',
      signetId: slack,
      message: 'Kingdom answered 503',
      refused: false,
    };
    const { state, effects } = feed(alone(), [down, down, down, down]);
    expect(notes(effects)).toHaveLength(4);
    expect(signetOf(state, slack).refusals).toBe(0);
    expect(state.ended).toBeNull();
  });

  test('an accepted presentation starts the refusal count again', () => {
    const { state, effects } = feed(alone(), [
      refused(slack),
      refused(slack),
      { type: 'presented', signetId: slack },
      refused(slack),
      refused(slack),
    ]);
    expect(signetOf(state, slack).refusals).toBe(2);
    expect(of(effects, 'finish')).toEqual([]);
    expect(state.ended).toBeNull();
    const third = feed(state, [refused(slack)]);
    expect(notes(third.effects)).toContain(gaveUp(3));
    expect(third.state.ended).toBe(1);
  });

  test('a Signet that has listened is never given up on, however often Kingdom refuses it afterwards', () => {
    const { state, effects } = feed(listening(), [
      { type: 'dropped', signetId: slack, at: 1_000 },
      ...Array.from({ length: 9 }, () => refused(slack)),
    ]);
    expect(signetOf(state, slack)).toMatchObject({ everListened: true, refusals: 9 });
    expect(of(effects, 'finish')).toEqual([]);
    expect(of(effects, 'closeSocket')).toEqual([]);
    expect(state.ended).toBeNull();
  });

  test('a Signet refused for good is waited on while another still listens, and ends with it', () => {
    const waitingOn = feed(started().state, [
      { type: 'presented', signetId: linear },
      { type: 'opened', signetId: linear, resourceId: engineering },
      refused(slack),
      refused(slack),
      refused(slack),
      refused(slack),
      { type: 'closed', signetId: linear, resourceId: design, reason: 'revoked', at: 9 },
    ]);
    expect(waitingOn.state.ended).toBeNull();
    const ended = feed(waitingOn.state, [
      { type: 'closed', signetId: linear, resourceId: engineering, reason: 'revoked', at: 9 },
    ]);
    expect(notes(ended.effects).slice(-2)).toEqual([
      gaveUp(4),
      'Every channel ended; nothing is left to listen on',
    ]);
    expect(of(ended.effects, 'finish')).toEqual([{ type: 'finish', code: 1 }]);
  });
});

describe('listenTransition: a Signet described again after a reopen', () => {
  const reopened = () =>
    feed(started().state, [
      { type: 'presented', signetId: linear },
      { type: 'opened', signetId: linear, resourceId: engineering },
      { type: 'opened', signetId: linear, resourceId: design },
      { type: 'opened', signetId: linear, resourceId: engineering },
    ]).state;
  const integration = (...channels: ListenChannel[]): ListenIntegration[] => [
    {
      integrationId: id(1),
      provider: 'linear',
      name: 'Tribe Linear',
      channels: channels.map((held) =>
        eventChannel(held.signetId, held.resourceId, {
          kind: held.resourceKind,
          name: held.resourceName,
          events: held.events,
        }),
      ),
    },
  ];
  const unchanged = integration(engineeringChannel, designChannel);

  test('every reopen starts the timer again; when it runs out, one describe', () => {
    const { state, effects } = feed(reopened(), [
      { type: 'opened', signetId: linear, resourceId: design },
      { type: 'rereadDue', signetId: linear },
    ]);
    expect(of(effects, 'rereadIn')).toEqual([{ type: 'rereadIn', signetId: linear, ms: 3_000 }]);
    expect(of(effects, 'describe')).toEqual([{ type: 'describe', signetId: linear }]);
    expect(signetOf(state, linear)).toMatchObject({ rereadScheduled: false, describing: 'yes' });
  });

  test('one describe at a time: a re-read due while one is in flight waits for its answer, then runs once', () => {
    const inFlight = feed(reopened(), [{ type: 'rereadDue', signetId: linear }]);
    expect(of(inFlight.effects, 'describe')).toHaveLength(1);
    const dueAgain = feed(inFlight.state, [
      { type: 'opened', signetId: linear, resourceId: design },
      { type: 'rereadDue', signetId: linear },
      { type: 'opened', signetId: linear, resourceId: design },
      { type: 'rereadDue', signetId: linear },
    ]);
    expect(of(dueAgain.effects, 'describe')).toEqual([]);
    expect(signetOf(dueAgain.state, linear).describing).toBe('again');
    const answered = feed(dueAgain.state, [
      { type: 'described', signetId: linear, integrations: unchanged, at: 9 },
    ]);
    expect(answered.effects).toEqual([{ type: 'describe', signetId: linear }]);
    expect(signetOf(answered.state, linear).describing).toBe('yes');
    const settled = feed(answered.state, [
      { type: 'described', signetId: linear, integrations: unchanged, at: 9 },
    ]);
    expect(settled.effects).toEqual([]);
    expect(signetOf(settled.state, linear).describing).toBe('no');
  });

  test('a channel the description added is opened and waits; one it dropped or that lost every admitted event is left', () => {
    const platform = channel(linear, general, 'Platform', 'events.Issue.create');
    const described = feed(
      feed(reopened(), [{ type: 'rereadDue', signetId: linear }]).state,
      [
        {
          type: 'described',
          signetId: linear,
          integrations: integration(
            { ...engineeringChannel, events: ['events.Comment.create'] },
            platform,
          ),
          at: 70_000,
        },
      ],
      { ...config, filters: ['events.Issue.*'] },
    );
    expect(described.effects).toEqual([
      { type: 'leave', signetId: linear, resourceId: engineering },
      {
        type: 'note',
        line: `Left ${label(engineeringChannel)}: it no longer holds an event --event events.Issue.* admits`,
      },
      { type: 'leave', signetId: linear, resourceId: design },
      { type: 'note', line: `Left ${label(designChannel)}: the Signet no longer holds it` },
      { type: 'open', signetId: linear, resourceId: general },
    ]);
    expect(signetOf(described.state, linear).channels).toEqual([
      { channel: platform, opened: false, waitingSince: 70_000, stallNotes: 0, closed: null },
    ]);
  });

  test('a kept channel takes its new name and keeps what it was doing', () => {
    const renamed = { ...engineeringChannel, resourceName: 'Platform' };
    const { state, effects } = feed(reopened(), [
      { type: 'rereadDue', signetId: linear },
      {
        type: 'described',
        signetId: linear,
        integrations: integration(renamed, designChannel),
        at: 9,
      },
      { type: 'gap', signetId: linear, resourceId: engineering, after: 1, seq: 5 },
    ]);
    expect(heldOf(state, linear, engineering)).toMatchObject({
      channel: renamed,
      opened: true,
      waitingSince: null,
    });
    expect(notes(effects).at(-1)).toStartWith(`Gap on ${label(renamed)}`);
  });

  test('a description that leaves the Signet nothing closes its socket; the last one ends the command 1', () => {
    const { state, effects } = feed(reopened(), [
      { type: 'rereadDue', signetId: linear },
      { type: 'described', signetId: linear, integrations: [], at: 9 },
    ]);
    expect(of(effects, 'leave')).toHaveLength(2);
    expect(of(effects, 'closeSocket')).toEqual([{ type: 'closeSocket', signetId: linear }]);
    expect(state.ended).toBeNull();
    const last = feed(state, [
      { type: 'closed', signetId: slack, resourceId: general, reason: 'revoked', at: 9 },
    ]);
    expect(last.state.ended).toBe(1);
  });

  test('a Signet Kingdom did not describe keeps its channels, and says so', () => {
    const before = feed(reopened(), [{ type: 'rereadDue', signetId: linear }]).state;
    const { state, effects } = feed(before, [
      { type: 'described', signetId: linear, integrations: null, at: 9 },
    ]);
    expect(effects).toEqual([
      {
        type: 'note',
        line: `Signet ${linear}: Kingdom did not describe it after a channel reopened; its channels and their names stay as they were`,
      },
    ]);
    expect(signetOf(state, linear).channels).toEqual(signetOf(before, linear).channels);
    expect(signetOf(state, linear).describing).toBe('no');
  });

  test('a re-read due for a Signet with no channel left is not made', () => {
    const { effects } = feed(reopened(), [
      { type: 'closed', signetId: linear, resourceId: engineering, reason: 'revoked', at: 1 },
      { type: 'closed', signetId: linear, resourceId: design, reason: 'revoked', at: 1 },
      { type: 'rereadDue', signetId: linear },
    ]);
    expect(of(effects, 'cancelReread')).toEqual([{ type: 'cancelReread', signetId: linear }]);
    expect(of(effects, 'describe')).toEqual([]);
  });
});

describe('listenTransition: events and a stdout that falls behind', () => {
  test('an event is one line to write, as NDJSON or as a short line', () => {
    const json = feed(listening(), [event(general, 'message-1')]);
    expect(of(json.effects, 'write').map(({ line }) => JSON.parse(line))).toEqual([
      {
        signetId: slack,
        integrationId: id(1),
        provider: 'linear',
        resourceId: general,
        resourceKind: 'team',
        resourceName: 'general',
        eventId: 'message-1',
        type: 'message.channels',
        seq: 1,
        event: {},
      },
    ]);
    expect(json.state.unflushed).toBe(1);
    expect(
      feed(listening(), [event(general, 'message-1')], { ...config, json: false }).effects,
    ).toEqual([{ type: 'write', line: '2026-11-13T11:00:00Z  linear  general  message.channels' }]);
  });

  test('a kind --event does not admit is neither written nor counted', () => {
    const { state, effects } = feed(listening(), [event(general, 'message-1')], {
      ...config,
      filters: ['events.Issue.*'],
    });
    expect(effects).toEqual([]);
    expect(state).toMatchObject({ unflushed: 0, dropped: 0 });
  });

  test('beyond the cap of writes stdout has not taken, events are dropped and nothing is said yet', () => {
    const { state, effects } = feed(
      listening(),
      [1, 2, 3, 4, 5].map((n) => event(general, `message-${n}`)),
    );
    expect(of(effects, 'write')).toHaveLength(2);
    expect(notes(effects)).toEqual([]);
    expect(state).toMatchObject({ unflushed: 2, dropped: 3 });
  });

  test('once stdout has caught up, one note says how many were dropped, and events are written again', () => {
    const behind = feed(
      listening(),
      [1, 2, 3, 4, 5].map((n) => event(general, `message-${n}`)),
    ).state;
    const one = feed(behind, [{ type: 'flushed' }]);
    expect(one.effects).toEqual([]);
    const caughtUp = feed(one.state, [{ type: 'flushed' }]);
    expect(caughtUp.effects).toEqual([
      {
        type: 'note',
        line: 'Dropped 3 events: stdout was not being read, and 2 written events were still waiting for it; events are live only',
      },
    ]);
    expect(caughtUp.state).toMatchObject({ unflushed: 0, dropped: 0 });
    const after = feed(caughtUp.state, [event(general, 'message-6'), { type: 'flushed' }]);
    expect(of(after.effects, 'write')).toHaveLength(1);
    expect(notes(after.effects)).toEqual([]);
  });

  test('while stdout is behind but taking writes, an event is written whenever there is room', () => {
    const { state, effects } = feed(listening(), [
      event(general, 'message-1'),
      event(general, 'message-2'),
      event(general, 'message-3'),
      { type: 'flushed' },
      event(general, 'message-4'),
      event(general, 'message-5'),
    ]);
    expect(of(effects, 'write').map(({ line }) => JSON.parse(line).eventId)).toEqual([
      'message-1',
      'message-2',
      'message-4',
    ]);
    expect(state).toMatchObject({ unflushed: 2, dropped: 2 });
  });

  test('a command that ends with events dropped says how many before it ends', () => {
    const behind = feed(
      listening(),
      [1, 2, 3].map((n) => event(general, `message-${n}`)),
    ).state;
    expect(feed(behind, [{ type: 'interrupt' }]).effects).toEqual([
      { type: 'closeSocket', signetId: slack },
      {
        type: 'note',
        line: 'Dropped 1 event: stdout was not being read, and 2 written events were still waiting for it; events are live only',
      },
      { type: 'finish', code: 0 },
    ]);
  });

  test('a reader that went away ends the command 0, with nothing said', () => {
    const { state, effects } = feed(listening(), [
      event(general, 'message-1'),
      {
        type: 'outputFailed',
        error: Object.assign(Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }),
      },
    ]);
    expect(effects.slice(1)).toEqual([
      { type: 'closeSocket', signetId: slack },
      { type: 'finish', code: 0 },
    ]);
    expect(state.ended).toBe(0);
  });

  test('any other failed write ends the command 1, and says why', () => {
    const { state, effects } = feed(listening(), [
      event(general, 'message-1'),
      {
        type: 'outputFailed',
        error: Object.assign(Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }),
      },
    ]);
    expect(effects.slice(1)).toEqual([
      {
        type: 'note',
        line: 'Stopped: stdout could not be written (ENOSPC: no space left on device, write)',
      },
      { type: 'closeSocket', signetId: slack },
      { type: 'finish', code: 1 },
    ]);
    expect(state.ended).toBe(1);
  });
});

describe('listenTransition: ending', () => {
  test('ending cancels every re-read that is scheduled, closes every socket, then finishes', () => {
    const scheduled = feed(started().state, [
      { type: 'opened', signetId: slack, resourceId: general },
      { type: 'opened', signetId: slack, resourceId: general },
    ]).state;
    expect(signetOf(scheduled, slack).rereadScheduled).toBe(true);
    const { state, effects } = feed(scheduled, [{ type: 'interrupt' }]);
    expect(effects).toEqual([
      { type: 'closeSocket', signetId: linear },
      { type: 'cancelReread', signetId: slack },
      { type: 'closeSocket', signetId: slack },
      { type: 'finish', code: 0 },
    ]);
    expect(state.ended).toBe(0);
    expect(state.signets.some((signet) => signet.rereadScheduled)).toBe(false);
  });

  test('an interrupt before anything is listening still finishes 0', () => {
    expect(feed(listenStart([], 0).state, [{ type: 'interrupt' }]).effects).toEqual([
      { type: 'finish', code: 0 },
    ]);
  });

  test('once ended, nothing that happens is noted, written or acted on', () => {
    const ended = feed(listening(), [{ type: 'interrupt' }]).state;
    const late: ListenInput[] = [
      event(general, 'late'),
      { type: 'flushed' },
      { type: 'outputFailed', error: Error('late') },
      { type: 'opened', signetId: slack, resourceId: general },
      { type: 'closed', signetId: slack, resourceId: general, reason: 'revoked', at: 9 },
      { type: 'dropped', signetId: slack, at: 9 },
      refused(slack),
      { type: 'tick', at: 9_000_000 },
      { type: 'rereadDue', signetId: slack },
      { type: 'described', signetId: slack, integrations: [], at: 9 },
      { type: 'interrupt' },
    ];
    expect(feed(ended, late)).toEqual({ state: ended, effects: [] });
  });
});
