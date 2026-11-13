import { describe, expect, test } from 'bun:test';
import {
  channelLabel,
  eventFilterAdmits,
  eventKindAdmitted,
  eventLine,
  formatEvent,
  type ListenChannel,
  listenChannels,
  noChannelReason,
  parseEventFilters,
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
});

describe('channelLabel', () => {
  test('names the provider, the resource and the Signet a note is about', () => {
    expect(channelLabel(engineering)).toBe(`linear Engineering (team ${id(21)}, Signet ${id(11)})`);
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
