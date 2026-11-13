import { describe, expect, test } from 'bun:test';
import { SignetHttpError } from '@inixiative/signet';
import {
  channelLabel,
  eventFilterAdmits,
  eventKindAdmitted,
  eventLine,
  formatEvent,
  type ListenChannel,
  listenChannels,
  listenIntegrations,
  ndjson,
  noChannelReason,
  nothingLeftToHear,
  parseEventFilters,
  presentationRefused,
  reconcileChannels,
  refusedForGood,
  stallNote,
  stallNoteDue,
  stdoutFailure,
  terminalSafe,
} from '../src/listening';
import { eventChannel, id } from './fixtures';

const linear = {
  integrationId: id(1),
  provider: 'linear',
  name: 'Tribe Linear',
  channels: [
    eventChannel(id(11), id(21), {
      kind: 'team',
      name: 'Engineering',
      events: ['events.Issue.create', 'events.Issue.update'],
    }),
    eventChannel(id(11), id(22), {
      kind: 'team',
      name: 'Design',
      events: ['events.Comment.create'],
    }),
  ],
};
const slack = {
  integrationId: id(2),
  provider: null,
  name: 'Tribe Slack',
  channels: [
    eventChannel(id(11), id(23), {
      kind: 'account',
      name: 'aron',
      events: ['events.app_mention', 'events.message.im'],
    }),
  ],
};
const listener = { signetId: id(11), integrations: [linear, slack] };
const engineering: ListenChannel = {
  signetId: id(11),
  integrationId: id(1),
  provider: 'linear',
  resourceId: id(21),
  resourceKind: 'team',
  resourceName: 'Engineering',
  events: ['events.Issue.create', 'events.Issue.update'],
};

describe('parseEventFilters', () => {
  test('takes event leaves and prefixes ending .*, once each', () => {
    expect(
      parseEventFilters(['events.Issue.create', 'events.message.*', 'events.Issue.create']),
    ).toEqual(['events.Issue.create', 'events.message.*']);
    expect(parseEventFilters(['events.*'])).toEqual(['events.*']);
    expect(parseEventFilters([])).toEqual([]);
  });
  test('refuses what could never match a channel', () => {
    expect(() => parseEventFilters(['Issue.create'])).toThrow(/--event takes an event leaf/);
    expect(() => parseEventFilters(['*'])).toThrow(/--event takes an event leaf/);
    expect(() => parseEventFilters(['events.'])).toThrow(/--event takes an event leaf/);
    expect(() => parseEventFilters(['documents.read'])).toThrow(/--event takes an event leaf/);
  });
  test('refuses an empty segment, which no event leaf has', () => {
    for (const value of ['events.Issue.', 'events..create', 'events..*', 'events.Issue..create'])
      expect(() => parseEventFilters([value])).toThrow(
        `--event takes an event leaf (events.Issue.create) or a prefix ending .* (events.Issue.*), not ${JSON.stringify(value)}`,
      );
  });
});

describe('eventFilterAdmits', () => {
  test('a leaf admits exactly itself', () => {
    expect(eventFilterAdmits('events.Issue.create', 'events.Issue.create')).toBe(true);
    expect(eventFilterAdmits('events.Issue.create', 'events.Issue.update')).toBe(false);
    expect(eventFilterAdmits('events.Issue', 'events.Issue.create')).toBe(false);
  });
  test('a prefix ending .* admits every leaf under it, never a sibling that starts the same', () => {
    expect(eventFilterAdmits('events.Issue.*', 'events.Issue.create')).toBe(true);
    expect(eventFilterAdmits('events.Issue.*', 'events.IssueLabel.create')).toBe(false);
    expect(eventFilterAdmits('events.Issue.*', 'events.Issue')).toBe(false);
    expect(eventFilterAdmits('events.*', 'events.app_mention')).toBe(true);
  });
});

describe('listenChannels', () => {
  test('with no filter, every channel of every integration, each carrying what a line names', () => {
    const channels = listenChannels(listener, []);
    expect(channels.map((channel) => channel.resourceId)).toEqual([id(21), id(22), id(23)]);
    expect(channels[0]).toEqual(engineering);
    expect(channels[2]).toMatchObject({ integrationId: id(2), provider: null });
  });
  test('a filter keeps the channels with at least one event it admits', () => {
    const resources = (filters: string[]) =>
      listenChannels(listener, filters).map((channel) => channel.resourceId);
    expect(resources(['events.Issue.update'])).toEqual([id(21)]);
    expect(resources(['events.message.*'])).toEqual([id(23)]);
    expect(resources(['events.Comment.*', 'events.app_mention'])).toEqual([id(22), id(23)]);
    expect(resources(['events.pull_request.*'])).toEqual([]);
  });
  test('a Signet with no integration has no channel', () => {
    expect(listenChannels({ signetId: id(11), integrations: [] }, [])).toEqual([]);
  });
});

describe('eventLine', () => {
  test('is the channel, then the append and its seq: one NDJSON object per event', () => {
    const event = { at: '2026-11-13T10:02:03.000Z', subject: { title: 'Fix login' } };
    const line = eventLine(engineering, { eventId: 'delivery-1', type: 'Issue.create', event }, 42);
    expect(line).toEqual({
      signetId: id(11),
      integrationId: id(1),
      provider: 'linear',
      resourceId: id(21),
      resourceKind: 'team',
      resourceName: 'Engineering',
      eventId: 'delivery-1',
      type: 'Issue.create',
      seq: 42,
      event,
    });
    expect(Object.keys(line)).toEqual([
      'signetId',
      'integrationId',
      'provider',
      'resourceId',
      'resourceKind',
      'resourceName',
      'eventId',
      'type',
      'seq',
      'event',
    ]);
  });
});

describe('formatEvent', () => {
  const received = new Date('2026-11-13T11:00:00.000Z');
  const line = (event: Record<string, unknown>, channel = engineering) =>
    formatEvent(eventLine(channel, { eventId: 'delivery-1', type: 'Issue.create', event }, 1), {
      received,
    });
  test('time, provider, resource, type and the subject title', () => {
    expect(line({ at: '2026-11-13T10:02:03.000Z', subject: { title: 'Fix login' } })).toBe(
      '2026-11-13T10:02:03Z  linear  Engineering  Issue.create  Fix login',
    );
  });
  test('the excerpt when there is no title, on one line and cut short', () => {
    expect(line({ at: '2026-11-13T10:02:03.000Z', subject: {}, excerpt: 'First\n  second' })).toBe(
      '2026-11-13T10:02:03Z  linear  Engineering  Issue.create  First second',
    );
    const long = line({ excerpt: 'x'.repeat(500) });
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(200);
  });
  test('a lens may trim the event to nothing: the time it arrived, and no text', () => {
    expect(line({})).toBe('2026-11-13T11:00:00Z  linear  Engineering  Issue.create');
    expect(line({ at: 'not a date', subject: 'trimmed', excerpt: 7 })).toBe(
      '2026-11-13T11:00:00Z  linear  Engineering  Issue.create',
    );
  });
  test('an integration with no provider shows a dash', () => {
    expect(line({}, { ...engineering, provider: null })).toBe(
      '2026-11-13T11:00:00Z  -  Engineering  Issue.create',
    );
  });
  test('a hostile title prints no escape sequence, bell, NUL, CSI or bidi override', () => {
    const printed = line({ at: '2026-11-13T10:02:03.000Z', subject: { title: hostileTitle } });
    expect(printed).toBe(
      '2026-11-13T10:02:03Z  linear  Engineering  Issue.create  Fix[1A[2K login31m gnp.exe',
    );
    expect(printed).not.toMatch(unprintable);
  });
  test('provider text in any field stays on one line: the resource name, the type, the excerpt', () => {
    const printed = formatEvent(
      eventLine(
        {
          ...engineering,
          provider: 'lin\near',
          resourceName:
            'Engineering\n2026-11-13T10:02:03Z  linear  Engineering  Issue.create  Spoofed',
        },
        {
          eventId: 'delivery-1',
          type: 'Issue.create\r\x1b[2K',
          event: { excerpt: 'a\u2028b\x1b]0;title\x07' },
        },
        1,
      ),
      { received },
    );
    expect(printed.split(lineBreak)).toHaveLength(1);
    expect(printed).not.toMatch(unprintable);
    expect(
      printed.startsWith('2026-11-13T11:00:00Z  lin ear  Engineering 2026-11-13T10:02:03Z linear'),
    ).toBe(true);
    expect(printed.endsWith('Issue.create [2K  a b]0;title')).toBe(true);
  });
});

describe('channelLabel', () => {
  test('names the provider, the resource and the Signet a note is about', () => {
    expect(channelLabel(engineering)).toBe(`linear Engineering (team ${id(21)}, Signet ${id(11)})`);
  });
  test('a provider-supplied name or kind can never start a second line or move the cursor', () => {
    const label = channelLabel({
      ...engineering,
      provider: 'lin\x1bear',
      resourceName: 'Engineering\nListening on linear Everything',
      resourceKind: 'te\u202eam\r',
    });
    expect(label).toBe(
      `linear Engineering Listening on linear Everything (team ${id(21)}, Signet ${id(11)})`,
    );
    expect(label).not.toMatch(unprintable);
  });
});

/** Everything `terminalSafe` promises is gone, and what any line-reader takes for a line break. */
const unprintable = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
const lineBreak = /\r\n|[\n\v\f\r\x85\u2028\u2029]/;
const hostileTitle = 'Fix\x1b[1A\x1b[2K login\x07\x00\u009b31m \u202egnp.exe';

describe('terminalSafe', () => {
  test('leaves ordinary text alone, accents, emoji and joiners included', () => {
    for (const text of ['Fix login', 'Zoë’s café — 日本語', '👩‍💻 ships it', ''])
      expect(terminalSafe(text)).toBe(text);
  });
  test('strips C0, DEL and C1 controls: no escape sequence, bell or NUL survives', () => {
    expect(terminalSafe('a\x00b\x07c\x1b[2Kd\x7fe\x80f\u009b1mg\u009fh')).toBe('abc[2Kdef1mgh');
    for (let code = 0; code <= 0x9f; code++)
      if (code < 0x20 || code >= 0x7f)
        expect(terminalSafe(`a${String.fromCharCode(code)}b`)).toMatch(/^a ?b$/);
  });
  test('strips the bidi marks, embeddings, overrides and isolates that reorder a line', () => {
    const bidi = [
      0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ];
    for (const code of bidi) expect(terminalSafe(`a${String.fromCharCode(code)}b`)).toBe('ab');
  });
  test('a line break of any kind, or a tab, becomes one space: words stay apart, the line stays one', () => {
    expect(terminalSafe('one\ntwo\r\nthree\u2028four\u2029five\x85six\tseven\v\feight')).toBe(
      'one two three four five six seven eight',
    );
    expect(terminalSafe('a\n\n  b')).toBe('a b');
  });
});

describe('ndjson', () => {
  const line = eventLine(
    { ...engineering, resourceName: 'Engi\u2028neering\x85' },
    {
      eventId: 'delivery-1',
      type: 'Issue.create',
      event: { subject: { title: hostileTitle }, excerpt: 'one\u2029two\ttab\x7f' },
    },
    7,
  );
  test('is one line to every line-reader, with no raw control or bidi character', () => {
    const text = ndjson(line);
    expect(text.split(lineBreak)).toHaveLength(1);
    expect(text).not.toMatch(unprintable);
  });
  test('parses back to exactly what was delivered', () => {
    expect(JSON.parse(ndjson(line))).toEqual(line);
    expect(JSON.parse(ndjson(line)).event.subject.title).toBe(hostileTitle);
  });
  test('ordinary events are printed as JSON.stringify prints them', () => {
    const plain = eventLine(
      engineering,
      { eventId: 'e', type: 'Issue.create', event: { n: 'Zoë 👩‍💻' } },
      1,
    );
    expect(ndjson(plain)).toBe(JSON.stringify(plain));
  });
});

describe('noChannelReason', () => {
  test('no channel at all: ask for event kinds on a Signet', () => {
    expect(noChannelReason([{ integrations: [] }], [])).toMatch(
      /^The held Signet has no event channel: ask an integration's owner/,
    );
    expect(
      noChannelReason([{ integrations: [] }, { integrations: [] }], ['events.Issue.*']),
    ).toMatch(/^None of the 2 held Signets has an event channel/);
  });
  test('channels, but none a filter admits: the filters, and the events the channels do hold', () => {
    expect(noChannelReason([listener], ['events.pull_request.*', 'events.issues.opened'])).toBe(
      'No event channel of the held Signet admits --event events.pull_request.*, events.issues.opened; its channels hold events.Comment.create, events.Issue.create, events.Issue.update, events.app_mention, events.message.im',
    );
  });
});

describe('eventKindAdmitted', () => {
  test('with no filter every event kind is printed', () => {
    expect(eventKindAdmitted([], 'Issue.create')).toBe(true);
  });

  test('with filters only the kinds they admit are printed, so a channel holding more kinds does not print the rest', () => {
    const filters = ['events.Issue.create', 'events.Comment.*'];
    expect(eventKindAdmitted(filters, 'Issue.create')).toBe(true);
    expect(eventKindAdmitted(filters, 'Comment.create')).toBe(true);
    expect(eventKindAdmitted(filters, 'Issue.update')).toBe(false);
  });
});

describe('noChannelReason, provider text', () => {
  test('an event leaf a channel holds is printed on one line', () => {
    const hostile = {
      integrations: [
        {
          ...linear,
          channels: [
            eventChannel(id(11), id(21), {
              kind: 'team',
              name: 'Engineering',
              events: ['events.Issue.create\n\x1b[2Kevents.Everything'],
            }),
          ],
        },
      ],
    };
    const reason = noChannelReason([hostile], ['events.pull_request.*']);
    expect(reason.split(lineBreak)).toHaveLength(1);
    expect(reason).not.toMatch(unprintable);
  });
});

describe('listenIntegrations', () => {
  test("a description's event channels, per integration; none from a Kingdom before integration events", () => {
    expect(
      listenIntegrations([
        {
          integration: { id: id(1), provider: 'linear', name: 'Tribe Linear' },
          channels: linear.channels,
        },
      ]),
    ).toEqual([linear]);
    expect(listenIntegrations(undefined)).toEqual([]);
  });
});

describe('stallNoteDue', () => {
  const dueAt = (notes: number) => {
    for (let waited = 0; ; waited += 1000) if (stallNoteDue(waited, notes, 15_000)) return waited;
  };
  test('the first note after the wait, then twice as long between notes each time', () => {
    expect(stallNoteDue(14_999, 0, 15_000)).toBe(false);
    expect([0, 1, 2, 3].map(dueAt)).toEqual([15_000, 45_000, 105_000, 225_000]);
  });
  test('never more than sixteen waits apart', () => {
    expect(dueAt(4)).toBe(465_000);
    expect(dueAt(5) - dueAt(4)).toBe(240_000);
    expect(dueAt(9) - dueAt(8)).toBe(240_000);
  });
});

describe('stallNote', () => {
  const label = `linear Engineering (team ${id(21)}, Signet ${id(11)})`;
  test('names the channel, how long it has waited, and what it is waiting for', () => {
    expect(stallNote(engineering, { waitedMs: 15_200, connected: false, refusals: 0 })).toBe(
      `Still not listening on ${label} after 15 s: no connection to Kingdom yet`,
    );
    expect(stallNote(engineering, { waitedMs: 45_000, connected: true, refusals: 0 })).toBe(
      `Still not listening on ${label} after 45 s: Kingdom accepted the Signet and has not opened the channel`,
    );
    expect(stallNote(engineering, { waitedMs: 240_000, connected: false, refusals: 2 })).toBe(
      `Still not listening on ${label} after 4 min: Kingdom refused the Signet's presentation, 2 times running`,
    );
    expect(stallNote(engineering, { waitedMs: 40, connected: false, refusals: 1 })).toBe(
      `Still not listening on ${label} after 40 ms: Kingdom refused the Signet's presentation`,
    );
  });
});

describe('presentationRefused', () => {
  test("the Signet socket's refusal, and Kingdom refusing the credential it presents with", () => {
    expect(presentationRefused(Error('Kingdom refused this Signet presentation'))).toBe(true);
    expect(presentationRefused(new SignetHttpError(403, 'revoked'))).toBe(true);
    expect(presentationRefused(new SignetHttpError(401))).toBe(true);
  });
  test('nothing else: a Kingdom that is down, a frame that did not parse', () => {
    expect(presentationRefused(new SignetHttpError(503))).toBe(false);
    expect(presentationRefused(Error('Kingdom presented another Signet on this socket'))).toBe(
      false,
    );
    expect(presentationRefused('Kingdom refused this Signet presentation')).toBe(false);
  });
});

describe('refusedForGood, nothingLeftToHear', () => {
  const listeningSignet = { channels: 2, everListened: true, refusals: 0 };
  const ended = { channels: 0, everListened: true, refusals: 0 };
  const refused = (refusals: number) => ({ channels: 1, everListened: false, refusals });
  test('a Signet is refused for good after the limit of refusals in a row, only if it never listened', () => {
    expect(refusedForGood(refused(2), 3)).toBe(false);
    expect(refusedForGood(refused(3), 3)).toBe(true);
    expect(refusedForGood({ channels: 1, everListened: true, refusals: 9 }, 3)).toBe(false);
  });
  test('nothing is left once every Signet has no channel or is refused for good', () => {
    expect(nothingLeftToHear([ended], 3)).toBe(true);
    expect(nothingLeftToHear([ended, refused(3)], 3)).toBe(true);
    expect(nothingLeftToHear([refused(3), refused(5)], 3)).toBe(true);
  });
  test('never while a channel is listening, still opening, or refused fewer times', () => {
    expect(nothingLeftToHear([listeningSignet, refused(9)], 3)).toBe(false);
    expect(nothingLeftToHear([ended, refused(2)], 3)).toBe(false);
    expect(nothingLeftToHear([ended, { channels: 1, everListened: false, refusals: 0 }], 3)).toBe(
      false,
    );
    expect(nothingLeftToHear([ended, { channels: 1, everListened: true, refusals: 9 }], 3)).toBe(
      false,
    );
  });
});

describe('reconcileChannels', () => {
  const open = listenChannels(listener, ['events.Issue.*', 'events.Comment.*']);
  const described = (channels: typeof linear.channels) => ({
    signetId: id(11),
    integrations: [{ ...linear, channels }],
  });
  const [engineeringChannel, designChannel] = linear.channels;
  if (!engineeringChannel || !designChannel) throw Error('fixture');
  test('nothing changed: every channel kept, none opened or left', () => {
    expect(reconcileChannels(open, listener, ['events.Issue.*', 'events.Comment.*'])).toEqual({
      opened: [],
      kept: open,
      left: [],
    });
  });
  test('a channel the revision added is opened, when a filter admits it', () => {
    const added = eventChannel(id(11), id(24), {
      kind: 'team',
      name: 'Platform',
      events: ['events.Issue.create'],
    });
    const unadmitted = eventChannel(id(11), id(25), {
      kind: 'team',
      name: 'Sales',
      events: ['events.Project.update'],
    });
    const plan = reconcileChannels(
      open,
      described([engineeringChannel, designChannel, added, unadmitted]),
      ['events.Issue.*', 'events.Comment.*'],
    );
    expect(plan.opened.map((channel) => channel.resourceName)).toEqual(['Platform']);
    expect(plan.kept).toEqual(open);
    expect(plan.left).toEqual([]);
  });
  test('a channel that is gone, or lost every kind a filter admits, is left, saying which', () => {
    const plan = reconcileChannels(
      open,
      described([{ ...engineeringChannel, events: ['events.Project.update'] }]),
      ['events.Issue.*', 'events.Comment.*'],
    );
    expect(plan.opened).toEqual([]);
    expect(plan.kept).toEqual([]);
    expect(plan.left).toEqual([
      { channel: open[0], why: 'unadmitted' },
      { channel: open[1], why: 'gone' },
    ]);
  });
  test('a kept channel takes its new name, kind and events', () => {
    const plan = reconcileChannels(
      open,
      described([
        { ...engineeringChannel, name: 'Platform', events: ['events.Issue.create'] },
        designChannel,
      ]),
      [],
    );
    expect(plan.kept[0]).toEqual({
      ...engineering,
      resourceName: 'Platform',
      events: ['events.Issue.create'],
    });
    expect(plan.left).toEqual([]);
  });
});

describe('stdoutFailure', () => {
  test('a reader that left (EPIPE) needs no note; any other failure is said', () => {
    expect(
      stdoutFailure(Object.assign(Error('EPIPE: broken pipe, write'), { code: 'EPIPE' })),
    ).toBe(null);
    expect(stdoutFailure(Object.assign(Error('ENOSPC: no space left'), { code: 'ENOSPC' }))).toBe(
      'Stopped: stdout could not be written (ENOSPC: no space left)',
    );
    expect(stdoutFailure('closed')).toBe('Stopped: stdout could not be written (closed)');
  });
});
