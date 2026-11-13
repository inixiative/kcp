import {
  type DescribeHeldSignet,
  SignetClient,
  SignetHolders,
  SignetSocket,
  type SignetSocketOptions,
} from '@inixiative/signet';
import {
  type ListenChannel,
  type ListenIntegration,
  listenChannels,
  listenIntegrations,
  noChannelReason,
  presentationRefused,
  terminalSafe,
} from './listening';
import {
  type ListenConfig,
  type ListenEffect,
  type ListenInput,
  type ListenState,
  listenStart,
  listenTransition,
} from './listenState';
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
  (signal: AbortSignal): DescribeHeldSignet =>
  ({ url, credentialFile, signetId }) =>
    new SignetClient(url, credentialFile, signetId).post('describe', { signetId }, undefined, {
      timeoutMs: 5_000,
      signal,
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
 * What it does once started is `listenTransition` (`listenState.ts`): this function only turns
 * what the sockets, the timers, `out` and `signal` report into its inputs, and performs the
 * effects it returns. `out` is never waited for: an event arriving while `maxUnflushed` written
 * ones still wait is dropped.
 *
 * Resolves 0 once `signal` aborts (startup included) or the reader of `out` has gone; 1 when a
 * write fails otherwise, or nothing is left to listen on. With nothing to listen on at the start
 * it throws, saying why, before any socket opens. However it ends, the sockets are closed, the
 * timers cleared and a read of Kingdom still in flight abandoned.
 */
export async function listen(input: {
  home: string;
  url: string;
  selection: Selection;
  json?: boolean;
  events?: readonly string[];
  /** Writes one event line, settling once stdout has taken it; a throw or rejection ends the command. */
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
  /** Events written and not yet taken by `out`, beyond which new ones are dropped. Default 1,000. */
  maxUnflushed?: number;
  socket?: Pick<SignetSocketOptions, 'retryBaseMs' | 'retryMaxMs'>;
}): Promise<number> {
  const { home, url, selection, signal } = input;
  const config: ListenConfig = {
    filters: input.events ?? [],
    json: input.json ?? false,
    stallMs: input.stallMs ?? 15_000,
    refusalLimit: input.refusalLimit ?? 3,
    rereadMs: input.rereadMs ?? 3_000,
    maxUnflushed: input.maxUnflushed ?? 1_000,
  };
  if (signal?.aborted) return 0;
  // Aborted when the command ends, however it ends: no read of Kingdom outlives it.
  const stopping = new AbortController();
  const holders = input.holders ?? new SignetHolders({ describe: describeUntil(stopping.signal) });
  const { promise: ended, resolve: end } = Promise.withResolvers<number>();
  const sockets = new Map<string, { listener: HeldListener; socket: SignetSocket }>();
  const rereads = new Map<string, ReturnType<typeof setTimeout>>();
  let state: ListenState = listenStart([], 0).state;
  let ticking: ReturnType<typeof setInterval> | null = null;

  const note = (line: string) => input.note(redactSecrets(terminalSafe(line)));
  const cancelReread = (signetId: string) => {
    clearTimeout(rereads.get(signetId));
    rereads.delete(signetId);
  };
  const write = (line: string) => {
    let taken: void | Promise<void>;
    try {
      taken = input.out(line);
    } catch (error) {
      return dispatch({ type: 'outputFailed', error });
    }
    Promise.resolve(taken).then(
      () => dispatch({ type: 'flushed' }),
      (error: unknown) => dispatch({ type: 'outputFailed', error }),
    );
  };
  /** Describes a Signet again; whatever happens to the read, the transition hears of it once. */
  const describe = (signetId: string) => {
    const listener = sockets.get(signetId)?.listener;
    if (!listener) return;
    holders.stale();
    Promise.resolve()
      .then(() => holders.get({ url, signetId, credentialFile: listener.credentialFile }, 10_000))
      .then(({ description }) =>
        description
          ? narrowToIntegration(
              { ...listener, integrations: listenIntegrations(description.eventChannels) },
              selection.integrationId,
            ).integrations
          : null,
      )
      .catch(() => null)
      .then((integrations) =>
        dispatch({ type: 'described', signetId, integrations, at: Date.now() }),
      );
  };
  const perform = (effect: ListenEffect) => {
    switch (effect.type) {
      case 'open':
        return sockets.get(effect.signetId)?.socket.openEventChannel(effect.resourceId);
      case 'leave':
        return sockets.get(effect.signetId)?.socket.leaveEventChannel(effect.resourceId);
      case 'closeSocket':
        return sockets.get(effect.signetId)?.socket.close();
      case 'rereadIn': {
        const { signetId } = effect;
        cancelReread(signetId);
        rereads.set(
          signetId,
          setTimeout(() => {
            rereads.delete(signetId);
            dispatch({ type: 'rereadDue', signetId });
          }, effect.ms),
        );
        return;
      }
      case 'cancelReread':
        return cancelReread(effect.signetId);
      case 'describe':
        return describe(effect.signetId);
      case 'write':
        return write(effect.line);
      case 'note':
        return note(effect.line);
      case 'finish':
        if (ticking) clearInterval(ticking);
        stopping.abort();
        return end(effect.code);
    }
  };
  // One input at a time: an effect that reports back at once (a write that throws) waits its turn.
  const inputs: ListenInput[] = [];
  let transitioning = false;
  function dispatch(next: ListenInput) {
    inputs.push(next);
    if (transitioning) return;
    transitioning = true;
    try {
      for (let taken = inputs.shift(); taken; taken = inputs.shift()) {
        const { state: after, effects } = listenTransition(state, taken, config);
        state = after;
        for (const effect of effects) perform(effect);
      }
    } finally {
      transitioning = false;
    }
  }

  const hear = (listener: HeldListener, client: SignetClient) => {
    const { signetId } = listener;
    return new SignetSocket({
      client,
      ...input.socket,
      onDisconnected: () => dispatch({ type: 'dropped', signetId, at: Date.now() }),
      onPresented: () => dispatch({ type: 'presented', signetId }),
      onError: (error) =>
        dispatch({
          type: 'error',
          signetId,
          message: error instanceof Error ? error.message : String(error),
          refused: presentationRefused(error),
        }),
      eventStreams: {
        // Never waits for stdout: Signet handles one frame at a time, so a write nobody takes
        // would hold back every later frame on this socket, a close among them.
        onEvent: ({ resourceId }, append, seq) =>
          dispatch({ type: 'event', signetId, resourceId, append, seq, received: new Date() }),
        onOpened: ({ resourceId }) => dispatch({ type: 'opened', signetId, resourceId }),
        onGap: ({ resourceId }, gap) => dispatch({ type: 'gap', signetId, resourceId, ...gap }),
        onClosed: ({ resourceId }, reason) =>
          dispatch({ type: 'closed', signetId, resourceId, reason, at: Date.now() }),
        onReopening: ({ resourceId }, reason) =>
          dispatch({ type: 'closed', signetId, resourceId, reason, at: Date.now() }),
      },
    });
  };

  const interrupted = () => dispatch({ type: 'interrupt' });
  signal?.addEventListener('abort', interrupted, { once: true });
  try {
    const reading = holdGrantedSignets(home, url, stopping.signal)
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
    const heard: { signetId: string; channels: ListenChannel[] }[] = [];
    for (const listener of route.listeners) {
      const channels = listenChannels(listener, config.filters);
      if (!channels.length) continue;
      const client = await SignetClient.fromFile(listener.credentialFile);
      if (stopping.signal.aborted) return ended;
      sockets.set(listener.signetId, { listener, socket: hear(listener, client) });
      heard.push({ signetId: listener.signetId, channels });
    }
    if (!heard.length) throw Error(noChannelReason(route.listeners, config.filters));
    const count = heard.reduce((sum, { channels }) => sum + channels.length, 0);
    note(
      `Connecting to ${url}: ${plural(count, 'channel')} on ${plural(heard.length, 'Signet')}; events are live only, nothing is replayed`,
    );
    const started = listenStart(heard, Date.now());
    state = started.state;
    for (const effect of started.effects) perform(effect);
    ticking = setInterval(
      () => dispatch({ type: 'tick', at: Date.now() }),
      Math.max(1, config.stallMs / 5),
    );
    for (const { socket } of sockets.values()) socket.start();
    return await ended;
  } finally {
    signal?.removeEventListener('abort', interrupted);
  }
}
