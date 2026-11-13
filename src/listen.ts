import {
  type DescribeHeldSignet,
  SignetClient,
  SignetHolders,
  SignetSocket,
  type SignetSocketOptions,
} from '@inixiative/signet';
import {
  channelLabel,
  eventKindAdmitted,
  eventLine,
  formatEvent,
  type ListenChannel,
  type ListenIntegration,
  leftNote,
  listenChannels,
  listenIntegrations,
  ndjson,
  noChannelReason,
  nothingLeftToHear,
  presentationRefused,
  reconcileChannels,
  stallNote,
  stallNoteDue,
  stdoutFailure,
  terminalSafe,
} from './listening';
import { type Listener, narrowToIntegration, resolveListeners, type UnreadSignet } from './routing';
import { heldViews } from './run';
import { redactSecrets } from './secrets';
import type { Selection } from './selectors';
import { holdGrantedSignets } from './session';

export type HeldListener = Listener & {
  credentialFile: string;
  integrations: readonly ListenIntegration[];
};

/**
 * This machine's held Signets as listening sees them: each one Kingdom describes, with the
 * integrations it has event channels on (`eventChannels`; none from a Kingdom before integration
 * events). The ones Kingdom refuses or doesn't answer for are returned apart, as `unread`.
 */
export async function heldListeners(home: string, url: string, holders = new SignetHolders()) {
  const listeners: HeldListener[] = [];
  const unread: UnreadSignet[] = [];
  // By Signet id, so what is listed and opened never depends on directory order.
  const held = (await heldViews(home, url, holders)).sort((a, b) =>
    a.credential.signetId.localeCompare(b.credential.signetId),
  );
  for (const { credential, view } of held) {
    if (!view.description) {
      unread.push({
        signetId: credential.signetId,
        status: view.status === 'revoked' ? 'revoked' : 'unavailable',
      });
      continue;
    }
    listeners.push({
      signetId: credential.signetId,
      credentialFile: credential.credentialFile,
      owner: credential.owner ?? null,
      integrations: listenIntegrations(view.description.eventChannels),
    });
  }
  return { listeners, unread };
}

/** `access/describe` as `SignetHolders` reads it, abandoned when `signal` aborts. */
const describeUntil =
  (signal: AbortSignal | undefined): DescribeHeldSignet =>
  ({ url, credentialFile, signetId }) =>
    new SignetClient(url, credentialFile, signetId).post('describe', { signetId }, undefined, {
      timeoutMs: 5_000,
      ...(signal ? { signal } : {}),
    });

/** One channel `listen` holds, or is waiting for Kingdom to open. */
type HeldChannel = {
  channel: ListenChannel;
  /** Kingdom has opened it before: its next open is a reopen. */
  opened: boolean;
  listening: boolean;
  /** Since when it has not been listening, and the notes that said so. */
  waitingSince: number;
  stallNotes: number;
};

/** One listening Signet: its socket, its channels by resource, and what the ending rule counts. */
type Hearing = {
  listener: HeldListener;
  socket: SignetSocket;
  channels: Map<string, HeldChannel>;
  everListened: boolean;
  refusals: number;
  rereadTimer: ReturnType<typeof setTimeout> | null;
  rereading: Promise<void>;
};

const waiting = (channel: ListenChannel): HeldChannel => ({
  channel,
  opened: false,
  listening: false,
  waitingSince: Date.now(),
  stallNotes: 0,
});
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * `kcp [selectors] listen`: listens to the integration events the held Signets grant, live. It
 * resolves the Signets the selectors admit, keeps the channels the `--event` filters admit, and
 * holds each over its Signet's own socket. Every event is one line on `out`; everything else
 * (opened, gap, closed, still waiting, errors) is one line on `note`, with secrets redacted and
 * provider text made `terminalSafe`. Nothing is replayed or deduped: an event published while a
 * channel wasn't open is gone, and one that arrives on two channels is printed for each.
 *
 * A channel that reopens (a revision, a reconnect) has its Signet described again, once per
 * `rereadMs` however many reopen: channels the description added are opened, ones it dropped or
 * that lost every admitted event are left, and names are refreshed. A channel still not listening
 * after `stallMs` is said so, then at a doubling interval (`stallNoteDue`).
 *
 * Resolves 0 once `signal` aborts (startup included) or `out` fails, since nobody is reading; 1
 * when nothing is left to listen on: Kingdom ended every channel, or the Signets left are refused
 * for good (`refusedForGood`, `refusalLimit`). With nothing to listen on at the start it throws,
 * saying why, before any socket opens.
 */
export async function listen(input: {
  home: string;
  url: string;
  selection: Selection;
  json?: boolean;
  events?: readonly string[];
  /** Writes one event line; a throw or rejection means stdout is closed, and ends the command. */
  out: (line: string) => void | Promise<void>;
  note: (line: string) => void;
  signal?: AbortSignal;
  holders?: SignetHolders;
  /** How long a channel may go without listening before a note says so. Default 15 s. */
  stallMs?: number;
  /** Refusals in a row after which a Signet that never listened counts as ended. Default 3. */
  refusalLimit?: number;
  /**
   * How long after a channel reopens its Signet is described again. Default 3 s: just over the
   * 2.5 s window `@inixiative/signet` paces opens in, so one revision is one describe.
   */
  rereadMs?: number;
  socket?: Pick<SignetSocketOptions, 'retryBaseMs' | 'retryMaxMs'>;
}): Promise<number> {
  const { home, url, selection, signal } = input;
  const filters = input.events ?? [];
  const stallMs = input.stallMs ?? 15_000;
  const refusalLimit = input.refusalLimit ?? 3;
  const rereadMs = input.rereadMs ?? 3_000;
  const holders = input.holders ?? new SignetHolders({ describe: describeUntil(signal) });
  const signets: Hearing[] = [];
  const { promise: ended, resolve: end } = Promise.withResolvers<number>();
  let over = false;
  let watch: ReturnType<typeof setInterval> | null = null;

  const note = (line: string) => {
    if (!over) input.note(redactSecrets(terminalSafe(line)));
  };
  const finish = (code: number) => {
    if (over) return;
    over = true;
    if (watch) clearInterval(watch);
    for (const { socket, rereadTimer } of signets) {
      if (rereadTimer) clearTimeout(rereadTimer);
      socket.close();
    }
    end(code);
  };
  const endIfNothingLeft = () => {
    const hearings = signets.map(({ channels, everListened, refusals }) => ({
      channels: channels.size,
      everListened,
      refusals,
    }));
    if (over || !nothingLeftToHear(hearings, refusalLimit)) return;
    for (const { listener, channels, refusals } of signets)
      if (channels.size)
        note(
          `Gave up on Signet ${listener.signetId}: Kingdom refused its presentation ${plural(refusals, 'time')} running and none of its channels ever opened (kcp status)`,
        );
    note('Every channel ended; nothing is left to listen on');
    finish(1);
  };
  const settle = (hearing: Hearing) => {
    if (!hearing.channels.size) hearing.socket.close();
    endIfNothingLeft();
  };

  /** Describes a Signet again and brings its channels in line with what it holds now. */
  const reread = async (hearing: Hearing) => {
    if (over || !hearing.channels.size) return;
    const { signetId, credentialFile } = hearing.listener;
    holders.stale();
    const { description } = await holders.get({ url, signetId, credentialFile }, 10_000);
    if (over || !hearing.channels.size) return;
    if (!description)
      return note(
        `Signet ${signetId}: Kingdom did not describe it after a channel reopened; its channels and their names stay as they were`,
      );
    const listener = narrowToIntegration(
      { ...hearing.listener, integrations: listenIntegrations(description.eventChannels) },
      selection.integrationId,
    );
    const open = [...hearing.channels.values()].map(({ channel }) => channel);
    const { opened, kept, left } = reconcileChannels(open, listener, filters);
    hearing.listener = listener;
    for (const { channel, why } of left) {
      hearing.channels.delete(channel.resourceId);
      hearing.socket.leaveEventChannel(channel.resourceId);
      note(leftNote(channel, why, filters));
    }
    for (const channel of kept) {
      const held = hearing.channels.get(channel.resourceId);
      if (held) held.channel = channel;
    }
    for (const channel of opened) {
      hearing.channels.set(channel.resourceId, waiting(channel));
      hearing.socket.openEventChannel(channel.resourceId);
    }
    settle(hearing);
  };
  // The client has no hook for a revision, so every reopen asks; the timer makes one describe of
  // the many reopens one revision or reconnect causes, and the chain keeps two from overlapping.
  const rereadSoon = (hearing: Hearing) => {
    if (hearing.rereadTimer) clearTimeout(hearing.rereadTimer);
    hearing.rereadTimer = setTimeout(() => {
      hearing.rereadTimer = null;
      hearing.rereading = hearing.rereading.then(() => reread(hearing));
    }, rereadMs);
  };

  const hear = (
    listener: HeldListener,
    channels: readonly ListenChannel[],
    client: SignetClient,
  ) => {
    const hearing: Hearing = {
      listener,
      channels: new Map(channels.map((channel) => [channel.resourceId, waiting(channel)])),
      everListened: false,
      refusals: 0,
      rereadTimer: null,
      rereading: Promise.resolve(),
      socket: new SignetSocket({
        client,
        ...input.socket,
        onPresented: () => {
          hearing.refusals = 0;
        },
        onError: (error) => {
          if (presentationRefused(error)) hearing.refusals++;
          note(
            `Signet ${listener.signetId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          endIfNothingLeft();
        },
        eventStreams: {
          onEvent: async ({ resourceId }, append, seq) => {
            const held = hearing.channels.get(resourceId);
            if (over || !held || !eventKindAdmitted(filters, append.type)) return;
            const line = eventLine(held.channel, append, seq);
            try {
              await input.out(
                input.json ? ndjson(line) : formatEvent(line, { received: new Date() }),
              );
            } catch (error) {
              const failure = stdoutFailure(error);
              if (failure) note(failure);
              finish(0);
            }
          },
          onOpened: ({ resourceId }) => {
            const held = hearing.channels.get(resourceId);
            if (!held) return;
            note(
              held.opened
                ? `Listening again on ${channelLabel(held.channel)}; events published meanwhile were not delivered`
                : `Listening on ${channelLabel(held.channel)}`,
            );
            if (held.opened) rereadSoon(hearing);
            held.opened = true;
            held.listening = true;
            hearing.everListened = true;
          },
          onGap: ({ resourceId }, { after, seq }) => {
            const held = hearing.channels.get(resourceId);
            if (held)
              note(
                `Gap on ${channelLabel(held.channel)}: seq ${after} to ${seq}; events in between were lost, or Kingdom restarted its count`,
              );
          },
          onClosed: ({ resourceId }, reason) => {
            const held = hearing.channels.get(resourceId);
            if (!held) return;
            hearing.channels.delete(resourceId);
            note(
              `Stopped listening on ${channelLabel(held.channel)}: ${reason ?? 'Kingdom gave no reason'}`,
            );
            settle(hearing);
          },
        },
      }),
    };
    for (const channel of channels) hearing.socket.openEventChannel(channel.resourceId);
    return hearing;
  };

  /** Says which channels are still not listening and why; a dropped connection starts the wait. */
  const reportStalls = () => {
    const now = Date.now();
    for (const { socket, channels, refusals } of signets) {
      const connected = socket.connected;
      for (const held of channels.values()) {
        if (held.listening && !connected) {
          held.listening = false;
          held.waitingSince = now;
          held.stallNotes = 0;
        }
        const waitedMs = now - held.waitingSince;
        if (held.listening || !stallNoteDue(waitedMs, held.stallNotes, stallMs)) continue;
        held.stallNotes++;
        note(stallNote(held.channel, { waitedMs, connected, refusals }));
      }
    }
  };

  if (signal?.aborted) return 0;
  const interrupted = () => finish(0);
  signal?.addEventListener('abort', interrupted, { once: true });
  try {
    const reading = holdGrantedSignets(home, url, signal)
      .catch(() => [])
      .then(() => heldListeners(home, url, holders));
    // An interrupt stops waiting for it; what it does afterwards has nobody to tell.
    reading.catch(() => {});
    const read = await Promise.race([reading, ended]);
    if (typeof read === 'number') return read;
    if (!selection.signetId)
      for (const { signetId, status } of read.unread)
        note(
          `Left out Signet ${signetId}: ${status === 'revoked' ? 'revoked, Kingdom refuses it' : 'Kingdom did not describe it'} (kcp status)`,
        );
    const route = resolveListeners({ selection, held: read.listeners, unread: read.unread });
    if (route.status !== 'resolved') throw Error(route.reason);
    for (const listener of route.listeners) {
      const channels = listenChannels(listener, filters);
      if (!channels.length) continue;
      const client = await SignetClient.fromFile(listener.credentialFile);
      if (over) return ended;
      signets.push(hear(listener, channels, client));
    }
    if (!signets.length) throw Error(noChannelReason(route.listeners, filters));
    const count = signets.reduce((sum, { channels }) => sum + channels.size, 0);
    note(
      `Connecting to ${url}: ${plural(count, 'channel')} on ${plural(signets.length, 'Signet')}; events are live only, nothing is replayed`,
    );
    watch = setInterval(reportStalls, Math.max(1, stallMs / 5));
    for (const { socket } of signets) socket.start();
    return await ended;
  } finally {
    signal?.removeEventListener('abort', interrupted);
  }
}
