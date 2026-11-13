import type { AccessEventsAppend } from '@inixiative/signet/contracts';
import {
  channelLabel,
  closeIsReopened,
  droppedNote,
  eventKindAdmitted,
  eventLine,
  formatEvent,
  type ListenChannel,
  type ListenIntegration,
  leftNote,
  ndjson,
  nothingLeftToHear,
  reconcileChannels,
  stallNote,
  stallNoteDue,
  stdoutFailure,
} from './listening';

/** What `kcp listen` was asked for; it never changes while the command runs. */
export type ListenConfig = {
  filters: readonly string[];
  json: boolean;
  /** How long a channel may go without listening before a note says so. */
  stallMs: number;
  /** Refusals in a row after which a Signet that never listened counts as ended. */
  refusalLimit: number;
  /** How long after a channel reopens its Signet is described again. */
  rereadMs: number;
  /** Events written to stdout and not yet taken by it, beyond which new ones are dropped. */
  maxUnflushed: number;
};

/** One channel `listen` holds, or is waiting for Kingdom to open. */
export type ChannelState = {
  channel: ListenChannel;
  /** Kingdom has opened it before: its next open is a reopen. */
  opened: boolean;
  /** Since when (ms) it has not been listening; null while it listens. */
  waitingSince: number | null;
  /** The notes that said it is still waiting. */
  stallNotes: number;
  /** The reason Kingdom closed it for, when it waits for Kingdom to reopen it. */
  closed: string | null;
};

/** One listening Signet: its channels, its socket as last heard of, and its re-read. */
export type SignetState = {
  signetId: string;
  channels: readonly ChannelState[];
  /** Kingdom has accepted its presentation on the connection it has now. */
  connected: boolean;
  everListened: boolean;
  /** Presentations Kingdom refused in a row. */
  refusals: number;
  /** A timer is running that ends in `rereadDue`. */
  rereadScheduled: boolean;
  /** A describe is in flight; `again` when another was due meanwhile and follows it. */
  describing: 'no' | 'yes' | 'again';
};

export type ListenState = {
  signets: readonly SignetState[];
  /** Events written to stdout that it has not taken yet. */
  unflushed: number;
  /** Events dropped since stdout last caught up. */
  dropped: number;
  /** The exit code once the command has ended; every later input is ignored. */
  ended: number | null;
};

/** Everything that happens to a running `listen`, as `listenTransition` takes it. */
export type ListenInput =
  /** Kingdom accepted (or renewed) a Signet's presentation. */
  | { type: 'presented'; signetId: string }
  /** A Signet's socket reported an error; `refused` when it is Kingdom refusing its presentation. */
  | { type: 'error'; signetId: string; message: string; refused: boolean }
  /** A Signet's connection to Kingdom closed. */
  | { type: 'dropped'; signetId: string; at: number }
  | { type: 'opened'; signetId: string; resourceId: string }
  /** Kingdom closed a channel, or refused its open: for good, or (`closeIsReopened`) until it reopens. */
  | { type: 'closed'; signetId: string; resourceId: string; reason: string | null; at: number }
  | { type: 'gap'; signetId: string; resourceId: string; after: number; seq: number }
  | {
      type: 'event';
      signetId: string;
      resourceId: string;
      append: AccessEventsAppend;
      seq: number;
      received: Date;
    }
  /** Stdout took one written event. */
  | { type: 'flushed' }
  | { type: 'outputFailed'; error: unknown }
  | { type: 'tick'; at: number }
  /** The timer `rereadIn` started ran out. */
  | { type: 'rereadDue'; signetId: string }
  /** A `describe` answered: the integrations the Signet has channels on now, null when unread. */
  | {
      type: 'described';
      signetId: string;
      integrations: readonly ListenIntegration[] | null;
      at: number;
    }
  | { type: 'interrupt' };

/** What `listen` does for a transition, in order. */
export type ListenEffect =
  | { type: 'open'; signetId: string; resourceId: string }
  | { type: 'leave'; signetId: string; resourceId: string }
  | { type: 'closeSocket'; signetId: string }
  /** Start the Signet's re-read timer, in place of one already running. */
  | { type: 'rereadIn'; signetId: string; ms: number }
  | { type: 'cancelReread'; signetId: string }
  | { type: 'describe'; signetId: string }
  | { type: 'write'; line: string }
  | { type: 'note'; line: string }
  /** Stop: abandon what is in flight and resolve with `code`. */
  | { type: 'finish'; code: number };

const waiting = (channel: ListenChannel, at: number): ChannelState => ({
  channel,
  opened: false,
  waitingSince: at,
  stallNotes: 0,
  closed: null,
});

/** The state `listen` starts in, and the opens that start it: every channel waiting since `at`. */
export function listenStart(
  signets: readonly { signetId: string; channels: readonly ListenChannel[] }[],
  at: number,
): { state: ListenState; effects: ListenEffect[] } {
  return {
    state: {
      signets: signets.map(({ signetId, channels }) => ({
        signetId,
        channels: channels.map((channel) => waiting(channel, at)),
        connected: false,
        everListened: false,
        refusals: 0,
        rereadScheduled: false,
        describing: 'no',
      })),
      unflushed: 0,
      dropped: 0,
      ended: null,
    },
    effects: signets.flatMap(({ signetId, channels }) =>
      channels.map(({ resourceId }) => ({ type: 'open' as const, signetId, resourceId })),
    ),
  };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * `kcp listen` as one pure step: the state it is in and one thing that happened give the state it
 * is in next and what to do about it. Nothing here reads a clock, a socket or a stream; `listen`
 * feeds it inputs and performs the effects it returns.
 *
 * A channel waits (`waitingSince`) from when it is asked for, from when its Signet's connection
 * drops, and from when Kingdom closes it for a reason it reopens after; `opened` ends the wait. A
 * `tick` notes the channels still waiting, at a doubling interval (`stallNoteDue`). A reopen has
 * its Signet described again `rereadMs` later, one describe at a time. An event is written unless
 * `maxUnflushed` written ones still wait for stdout; then it is dropped, and one note says how many
 * once stdout has caught up or the command ends. The command ends 0 on an interrupt or a reader
 * that went away, 1 when a write fails otherwise or nothing is left to listen on
 * (`nothingLeftToHear`). Once ended, nothing more happens.
 */
export function listenTransition(
  state: ListenState,
  input: ListenInput,
  config: ListenConfig,
): { state: ListenState; effects: ListenEffect[] } {
  if (state.ended !== null) return { state, effects: [] };
  const effects: ListenEffect[] = [];
  const next = {
    ...state,
    signets: state.signets.map((signet) => ({
      ...signet,
      channels: signet.channels.map((held) => ({ ...held })),
    })),
  };
  const note = (line: string) => void effects.push({ type: 'note', line });

  const finish = (code: number) => {
    for (const signet of next.signets) {
      if (signet.rereadScheduled) effects.push({ type: 'cancelReread', signetId: signet.signetId });
      signet.rereadScheduled = false;
      effects.push({ type: 'closeSocket', signetId: signet.signetId });
    }
    if (next.dropped) note(droppedNote(next.dropped, config.maxUnflushed));
    effects.push({ type: 'finish', code });
    next.ended = code;
  };
  const endIfNothingLeft = () => {
    const hearings = next.signets.map(({ channels, everListened, refusals }) => ({
      channels: channels.length,
      everListened,
      refusals,
    }));
    if (!nothingLeftToHear(hearings, config.refusalLimit)) return;
    for (const { signetId, channels, refusals } of next.signets)
      if (channels.length)
        note(
          `Gave up on Signet ${signetId}: Kingdom refused its presentation ${plural(refusals, 'time')} running and none of its channels ever opened (kcp status)`,
        );
    note('Every channel ended; nothing is left to listen on');
    finish(1);
  };
  /** A Signet with no channel left has no use for its socket or its re-read. */
  const settle = (signet: (typeof next.signets)[number]) => {
    if (!signet.channels.length) {
      if (signet.rereadScheduled) effects.push({ type: 'cancelReread', signetId: signet.signetId });
      signet.rereadScheduled = false;
      effects.push({ type: 'closeSocket', signetId: signet.signetId });
    }
    endIfNothingLeft();
  };
  const wait = (held: ChannelState, at: number, closed: string | null) => {
    held.closed = closed;
    if (held.waitingSince !== null) return;
    held.waitingSince = at;
    held.stallNotes = 0;
  };

  const signet =
    'signetId' in input ? next.signets.find(({ signetId }) => signetId === input.signetId) : null;
  const held =
    signet && 'resourceId' in input
      ? signet.channels.find(({ channel }) => channel.resourceId === input.resourceId)
      : null;

  switch (input.type) {
    case 'presented':
      if (!signet) break;
      signet.connected = true;
      signet.refusals = 0;
      break;
    case 'error':
      if (!signet) break;
      if (input.refused) signet.refusals++;
      note(`Signet ${signet.signetId}: ${input.message}`);
      endIfNothingLeft();
      break;
    case 'dropped':
      if (!signet) break;
      signet.connected = false;
      for (const channel of signet.channels) wait(channel, input.at, null);
      break;
    case 'opened':
      if (!signet || !held) break;
      note(
        held.opened
          ? `Listening again on ${channelLabel(held.channel)}; events published meanwhile were not delivered`
          : `Listening on ${channelLabel(held.channel)}`,
      );
      // The client has no hook for a revision, so every reopen asks; the timer makes one describe
      // of the many reopens one revision or reconnect causes.
      if (held.opened) {
        signet.rereadScheduled = true;
        effects.push({ type: 'rereadIn', signetId: signet.signetId, ms: config.rereadMs });
      }
      held.opened = true;
      held.waitingSince = null;
      held.stallNotes = 0;
      held.closed = null;
      signet.everListened = true;
      break;
    case 'closed':
      if (!signet || !held) break;
      if (closeIsReopened(input.reason)) {
        wait(held, input.at, input.reason);
        break;
      }
      signet.channels = signet.channels.filter((channel) => channel !== held);
      note(
        `Stopped listening on ${channelLabel(held.channel)}: ${input.reason ?? 'Kingdom gave no reason'}`,
      );
      settle(signet);
      break;
    case 'gap':
      if (held)
        note(
          `Gap on ${channelLabel(held.channel)}: seq ${input.after} to ${input.seq}; events in between were lost, or Kingdom restarted its count`,
        );
      break;
    case 'event': {
      if (!held || !eventKindAdmitted(config.filters, input.append.type)) break;
      if (next.unflushed >= config.maxUnflushed) {
        next.dropped++;
        break;
      }
      next.unflushed++;
      const line = eventLine(held.channel, input.append, input.seq);
      effects.push({
        type: 'write',
        line: config.json ? ndjson(line) : formatEvent(line, { received: input.received }),
      });
      break;
    }
    case 'flushed':
      next.unflushed = Math.max(0, next.unflushed - 1);
      if (next.unflushed === 0 && next.dropped) {
        note(droppedNote(next.dropped, config.maxUnflushed));
        next.dropped = 0;
      }
      break;
    case 'outputFailed': {
      const failure = stdoutFailure(input.error);
      if (failure.note) note(failure.note);
      finish(failure.code);
      break;
    }
    case 'tick':
      for (const { channels, connected, refusals } of next.signets)
        for (const channel of channels) {
          if (channel.waitingSince === null) continue;
          const waitedMs = input.at - channel.waitingSince;
          if (!stallNoteDue(waitedMs, channel.stallNotes, config.stallMs)) continue;
          channel.stallNotes++;
          note(
            stallNote(channel.channel, { waitedMs, connected, refusals, closed: channel.closed }),
          );
        }
      break;
    case 'rereadDue':
      if (!signet) break;
      signet.rereadScheduled = false;
      if (!signet.channels.length) break;
      // One describe at a time: a second would race the first for which channels are open.
      if (signet.describing !== 'no') {
        signet.describing = 'again';
        break;
      }
      signet.describing = 'yes';
      effects.push({ type: 'describe', signetId: signet.signetId });
      break;
    case 'described': {
      if (!signet) break;
      const again = signet.describing === 'again';
      signet.describing = 'no';
      if (!signet.channels.length) break;
      if (!input.integrations) {
        note(
          `Signet ${signet.signetId}: Kingdom did not describe it after a channel reopened; its channels and their names stay as they were`,
        );
      } else {
        const { opened, kept, left } = reconcileChannels(
          signet.channels.map(({ channel }) => channel),
          { signetId: signet.signetId, integrations: input.integrations },
          config.filters,
        );
        const now = new Map(kept.map((channel) => [channel.resourceId, channel]));
        signet.channels = [
          ...signet.channels.flatMap((channel) => {
            const described = now.get(channel.channel.resourceId);
            return described ? [{ ...channel, channel: described }] : [];
          }),
          ...opened.map((channel) => waiting(channel, input.at)),
        ];
        for (const { channel, why } of left) {
          effects.push({
            type: 'leave',
            signetId: signet.signetId,
            resourceId: channel.resourceId,
          });
          note(leftNote(channel, why, config.filters));
        }
        for (const { resourceId } of opened)
          effects.push({ type: 'open', signetId: signet.signetId, resourceId });
        settle(signet);
      }
      if (again && signet.channels.length && next.ended === null) {
        signet.describing = 'yes';
        effects.push({ type: 'describe', signetId: signet.signetId });
      }
      break;
    }
    case 'interrupt':
      finish(0);
      break;
  }
  return { state: next, effects };
}
