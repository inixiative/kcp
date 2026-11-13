import type { AccessEventsAppend, EventChannel } from '@inixiative/signet/contracts';

/** An integration a held Signet has event channels on, as `eventChannels` on `access/describe` lists it. */
export type ListenIntegration = {
  integrationId: string;
  provider: string | null;
  name: string;
  channels: readonly EventChannel[];
};

/** One channel `kcp listen` opens: the Signet it listens with, and what every line of it names. */
export type ListenChannel = {
  signetId: string;
  integrationId: string;
  provider: string | null;
  resourceId: string;
  resourceKind: string;
  resourceName: string;
  /** The event leaves (`events.<event>.<action>`) the Signet holds on the resource. */
  events: string[];
};

const eventFilter = /^events\.[^*\s]+(\.\*)?$|^events\.\*$/;

/**
 * `--event` values: an event leaf (`events.Issue.create`) or a prefix ending `.*`
 * (`events.Issue.*`), once each. Anything else could never match a channel, so it is refused.
 */
export function parseEventFilters(values: readonly string[]): string[] {
  for (const value of values)
    if (!eventFilter.test(value))
      throw Error(
        `--event takes an event leaf (events.Issue.create) or a prefix ending .* (events.Issue.*), not ${JSON.stringify(value)}`,
      );
  return [...new Set(values)];
}

/** Whether a filter admits an event leaf: a leaf admits itself, a prefix every leaf under it. */
export const eventFilterAdmits = (filter: string, leaf: string) =>
  filter.endsWith('.*') ? leaf.startsWith(filter.slice(0, -1)) : leaf === filter;

/** Whether an arriving event's kind (`Issue.create`) is one the filters ask for; no filter asks for all. */
export const eventKindAdmitted = (filters: readonly string[], type: string) =>
  filters.length === 0 || filters.some((filter) => eventFilterAdmits(filter, `events.${type}`));

/**
 * The channels of one held Signet that `kcp listen` opens: with no filter, all of them; else those
 * holding at least one event a filter admits. Kingdom delivers every kind the Signet holds on an
 * open channel, so the same filters also decide what is printed (`eventKindAdmitted`).
 */
export function listenChannels(
  listener: { signetId: string; integrations: readonly ListenIntegration[] },
  filters: readonly string[],
): ListenChannel[] {
  return listener.integrations.flatMap(({ integrationId, provider, channels }) =>
    channels
      .filter(
        (channel) =>
          !filters.length ||
          channel.events.some((leaf) => filters.some((filter) => eventFilterAdmits(filter, leaf))),
      )
      .map((channel) => ({
        signetId: listener.signetId,
        integrationId,
        provider,
        resourceId: channel.resourceId,
        resourceKind: channel.kind,
        resourceName: channel.name,
        events: [...channel.events],
      })),
  );
}

/** One event as `kcp listen --json` prints it: one object per line. */
export type EventLine = Omit<ListenChannel, 'events'> & {
  eventId: string;
  type: string;
  seq: number;
  event: Record<string, unknown>;
};

export const eventLine = (
  { events: _events, ...channel }: ListenChannel,
  append: AccessEventsAppend,
  seq: number,
): EventLine => ({
  ...channel,
  eventId: append.eventId,
  type: append.type,
  seq,
  event: append.event,
});

const excerptLength = 120;
const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > excerptLength ? `${line.slice(0, excerptLength)}…` : line;
};

/** The text an event shows: its subject's title, else its excerpt. A lens may have trimmed both. */
function eventText(event: Record<string, unknown>) {
  const subject = event.subject;
  const title =
    typeof subject === 'object' && subject !== null && 'title' in subject ? subject.title : null;
  if (typeof title === 'string' && title.trim()) return oneLine(title);
  return typeof event.excerpt === 'string' ? oneLine(event.excerpt) : '';
}

/**
 * One event as a line a person reads: when it happened (when it arrived, if the event doesn't
 * say), the provider, the resource, the event type, and its title or excerpt when it has one.
 */
export function formatEvent(line: EventLine, { received }: { received: Date }) {
  const at = typeof line.event.at === 'string' ? new Date(line.event.at) : received;
  const time = Number.isNaN(at.getTime()) ? received : at;
  return [
    `${time.toISOString().slice(0, 19)}Z`,
    line.provider ?? '-',
    line.resourceName,
    line.type,
    eventText(line.event),
  ]
    .filter(Boolean)
    .join('  ');
}

/** A channel as the notes on stderr name it. */
export const channelLabel = (channel: Omit<ListenChannel, 'events'>) =>
  `${channel.provider ?? '-'} ${channel.resourceName} (${channel.resourceKind} ${channel.resourceId}, Signet ${channel.signetId})`;

/** Why there is nothing to listen on: no channel at all, or none the `--event` filters admit. */
export function noChannelReason(
  listeners: readonly { integrations: readonly ListenIntegration[] }[],
  filters: readonly string[],
) {
  const held = [
    ...new Set(
      listeners.flatMap(({ integrations }) =>
        integrations.flatMap(({ channels }) => channels.flatMap((channel) => channel.events)),
      ),
    ),
  ].sort();
  const one = listeners.length === 1;
  if (!held.length)
    return `${one ? 'The held Signet has no' : `None of the ${listeners.length} held Signets has an`} event channel: ask an integration's owner to grant event kinds (events.…) on a Signet, then run kcp status`;
  return `No event channel of ${one ? 'the held Signet' : `the ${listeners.length} held Signets`} admits --event ${filters.join(', ')}; ${one ? 'its' : 'their'} channels hold ${held.join(', ')}`;
}
