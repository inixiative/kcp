import { SignetHttpError } from '@inixiative/signet';
import {
  type AccessEventsAppend,
  type EventChannel,
  type EventChannelMap,
  eventOperationKey,
} from '@inixiative/signet/contracts';

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

/**
 * What provider text must never bring to a terminal: the C0, DEL and C1 controls (escape
 * sequences, the bell, NUL, the 8-bit CSI), the line and paragraph separators, and the bidi marks,
 * embeddings, overrides and isolates (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069)
 * that reorder a line.
 */
const unprintable = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu;
/** A run of white space, the line breaks among it (NEL, U+0085, is one `\s` leaves out). */
const whiteSpace = /[\s\u0085]+/g;

/**
 * Provider text (an issue title, a resource name, an event type) as `kcp listen` prints it for a
 * person: a run of white space, line breaks included, is one space, and every other control or
 * bidi character is gone. What is left can't start a line, move the cursor or reorder the line.
 */
export const terminalSafe = (text: string) =>
  text.replace(whiteSpace, ' ').replace(unprintable, '');

/**
 * One value as one NDJSON line. `JSON.stringify` escapes the C0 controls; the rest of what
 * `terminalSafe` strips is escaped here (`\u2028`), so a reader that splits on any line break sees
 * one line per event, a terminal sees no control, and parsing gives back exactly what was delivered.
 */
export const ndjson = (value: unknown) =>
  JSON.stringify(value).replace(
    unprintable,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** An `events.` leaf or a prefix ending `.*`; a segment is never empty and holds no `*`. */
const eventFilter = /^events(\.[^.*\s]+)+(\.\*)?$|^events\.\*$/;

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
  filters.length === 0 ||
  filters.some((filter) => eventFilterAdmits(filter, eventOperationKey(type)));

/** A description's `eventChannels` as listening holds them; none from a Kingdom before integration events. */
export const listenIntegrations = (
  eventChannels: EventChannelMap | undefined,
): ListenIntegration[] =>
  (eventChannels ?? []).map(({ integration, channels }) => ({
    integrationId: integration.id,
    provider: integration.provider,
    name: integration.name,
    channels,
  }));

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
  const line = terminalSafe(text).trim();
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
 * Every field a provider wrote is printed `terminalSafe`.
 */
export function formatEvent(line: EventLine, { received }: { received: Date }) {
  const at = typeof line.event.at === 'string' ? new Date(line.event.at) : received;
  const time = Number.isNaN(at.getTime()) ? received : at;
  return [
    `${time.toISOString().slice(0, 19)}Z`,
    terminalSafe(line.provider ?? '-'),
    terminalSafe(line.resourceName),
    terminalSafe(line.type),
    eventText(line.event),
  ]
    .filter(Boolean)
    .join('  ');
}

/** A channel as the notes on stderr name it, `terminalSafe`: one line whatever the resource is called. */
export const channelLabel = (channel: Omit<ListenChannel, 'events'>) =>
  terminalSafe(
    `${channel.provider ?? '-'} ${channel.resourceName} (${channel.resourceKind} ${channel.resourceId}, Signet ${channel.signetId})`,
  );

/** Why there is nothing to listen on: no channel at all, or none the `--event` filters admit. */
export function noChannelReason(
  listeners: readonly { integrations: readonly ListenIntegration[] }[],
  filters: readonly string[],
) {
  const held = [
    ...new Set(
      listeners.flatMap(({ integrations }) =>
        integrations.flatMap(({ channels }) =>
          channels.flatMap((channel) => channel.events.map(terminalSafe)),
        ),
      ),
    ),
  ].sort();
  const one = listeners.length === 1;
  if (!held.length)
    return `${one ? 'The held Signet has no' : `None of the ${listeners.length} held Signets has an`} event channel: ask an integration's owner to grant event kinds (events.…) on a Signet, then run kcp status`;
  return `No event channel of ${one ? 'the held Signet' : `the ${listeners.length} held Signets`} admits --event ${filters.join(', ')}; ${one ? 'its' : 'their'} channels hold ${held.join(', ')}`;
}

/**
 * What a Signet's channels become once Kingdom describes it again (after a revision, or a
 * reconnect): the channels to open because the description now holds them and a filter admits
 * them, the open ones to keep, each as it is described now (a renamed resource takes its new
 * name), and the open ones to leave, either `gone` from the description or `unadmitted` because
 * they lost every event a filter admits.
 */
export function reconcileChannels(
  open: readonly ListenChannel[],
  listener: { signetId: string; integrations: readonly ListenIntegration[] },
  filters: readonly string[],
) {
  const byResource = (channels: readonly ListenChannel[]) =>
    new Map(channels.map((channel) => [channel.resourceId, channel]));
  const described = byResource(listenChannels(listener, []));
  const admitted = byResource(listenChannels(listener, filters));
  const wasOpen = byResource(open);
  return {
    opened: [...admitted.values()].filter((channel) => !wasOpen.has(channel.resourceId)),
    kept: open.flatMap((channel) => admitted.get(channel.resourceId) ?? []),
    left: open
      .filter((channel) => !admitted.has(channel.resourceId))
      .map((channel) => ({
        channel,
        why: described.has(channel.resourceId) ? ('unadmitted' as const) : ('gone' as const),
      })),
  };
}

/** The note for a channel `kcp listen` left after its Signet was described again. */
export const leftNote = (
  channel: ListenChannel,
  why: 'gone' | 'unadmitted',
  filters: readonly string[],
) =>
  `Left ${channelLabel(channel)}: ${why === 'gone' ? 'the Signet no longer holds it' : `it no longer holds an event --event ${filters.join(', ')} admits`}`;

/** The longest a channel that is still not listening goes between notes, in waits. */
const stallNoteCap = 16;

/**
 * Whether a channel that has gone `waitedMs` without listening, and was reported `notes` times, is
 * due its next note: the first after `waitMs`, then twice as long between notes each time (with
 * the default 15 s: at 15 s, 45 s, 1 min 45 s, 3 min 45 s), never more than sixteen waits apart.
 */
export function stallNoteDue(waitedMs: number, notes: number, waitMs: number) {
  let due = 0;
  for (let note = 0; note <= notes; note++) due += Math.min(2 ** note, stallNoteCap) * waitMs;
  return waitedMs >= due;
}

const elapsed = (ms: number) =>
  ms < 1000
    ? `${Math.round(ms)} ms`
    : ms < 120_000
      ? `${Math.round(ms / 1000)} s`
      : `${Math.round(ms / 60_000)} min`;

/**
 * The note for a channel still not listening: which one, for how long, and what it waits for.
 * Its Signet's socket is not connected (never was, or dropped), Kingdom refused the Signet's last
 * `refusals` presentations, or Kingdom accepted the Signet and has not answered the open.
 */
export const stallNote = (
  channel: ListenChannel,
  stall: { waitedMs: number; connected: boolean; refusals: number },
) =>
  `Still not listening on ${channelLabel(channel)} after ${elapsed(stall.waitedMs)}: ${
    stall.connected
      ? 'Kingdom accepted the Signet and has not opened the channel'
      : stall.refusals
        ? `Kingdom refused the Signet's presentation${stall.refusals > 1 ? `, ${stall.refusals} times running` : ''}`
        : 'no connection to Kingdom yet'
  }`;

/** What `SignetSocket` (`@inixiative/signet`) reports when Kingdom answers a presentation `signetRejected`. */
const socketRefusal = 'Kingdom refused this Signet presentation';

/**
 * Whether an error a Signet's socket reported is Kingdom refusing its presentation: the socket's
 * own refusal, or Kingdom refusing (401, 403) the credential it presents with. A Kingdom that is
 * down or a frame that didn't parse is not a refusal.
 */
export const presentationRefused = (error: unknown) =>
  error instanceof SignetHttpError
    ? error.status === 401 || error.status === 403
    : error instanceof Error && error.message === socketRefusal;

/** One listening Signet as the ending rule sees it. */
export type SignetHearing = {
  /** The channels it has open or is opening; those Kingdom ended or `listen` left are not counted. */
  channels: number;
  /** Whether any channel of it ever opened. */
  everListened: boolean;
  /** Presentations Kingdom has refused in a row; an accepted one starts the count again. */
  refusals: number;
};

/**
 * A Signet `kcp listen` stops waiting for: none of its channels ever opened, and Kingdom has
 * refused its presentation `limit` times in a row. One that has listened is retried for as long as
 * the command runs: a refusal after that may pass (Kingdom restarting), and its events matter.
 */
export const refusedForGood = (signet: SignetHearing, limit: number) =>
  signet.channels > 0 && !signet.everListened && signet.refusals >= limit;

/**
 * Whether nothing is left to listen on, which ends the command: every Signet has no channel left
 * (Kingdom ended each, or `listen` left it) or is `refusedForGood`. Never while a channel is
 * listening, or one may still open: not connected yet, not answered yet, refused fewer times.
 */
export const nothingLeftToHear = (signets: readonly SignetHearing[], limit: number) =>
  signets.every((signet) => signet.channels === 0 || refusedForGood(signet, limit));

/**
 * What stderr says when an event could not be written to stdout: nothing when the reader left
 * (EPIPE, as after `| head -1`), else the failure. Either way `listen` stops: nobody is reading.
 */
export const stdoutFailure = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === 'EPIPE'
    ? null
    : `Stopped: stdout could not be written (${error instanceof Error ? error.message : String(error)})`;
