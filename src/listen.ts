import {
  type EventStreamKey,
  type HolderView,
  SignetClient,
  SignetHolders,
  SignetSocket,
} from '@inixiative/signet';
import {
  channelLabel,
  eventKindAdmitted,
  eventLine,
  formatEvent,
  type ListenChannel,
  type ListenIntegration,
  listenChannels,
  noChannelReason,
} from './listening';
import { type Listener, resolveListeners } from './routing';
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
  const unread: { signetId: string; status: HolderView['status'] }[] = [];
  // By Signet id, so what is listed and opened never depends on directory order.
  const held = (await heldViews(home, url, holders)).sort((a, b) =>
    a.credential.signetId.localeCompare(b.credential.signetId),
  );
  for (const { credential, view } of held) {
    if (!view.description) {
      unread.push({ signetId: credential.signetId, status: view.status });
      continue;
    }
    listeners.push({
      signetId: credential.signetId,
      credentialFile: credential.credentialFile,
      owner: credential.owner ?? null,
      integrations: (view.description.eventChannels ?? []).map(({ integration, channels }) => ({
        integrationId: integration.id,
        provider: integration.provider,
        name: integration.name,
        channels,
      })),
    });
  }
  return { listeners, unread };
}

const channelKey = ({ signetId, resourceId }: EventStreamKey) => `${signetId}:${resourceId}`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * `kcp [selectors] listen`: listens to the integration events the held Signets grant, live. It
 * resolves the Signets the selectors admit, keeps the channels the `--event` filters admit, and
 * holds each over its Signet's own socket. Every event is one line on `out`; everything else
 * (opened, gap, closed, errors) is a line on `note`, with secrets redacted. Nothing is replayed or
 * deduped: an event published while a channel wasn't open is gone, and one that arrives on two
 * channels is printed for each.
 *
 * Resolves 0 once `signal` aborts, 1 when Kingdom has ended every channel for good. With nothing
 * to listen on it throws, saying why, before any socket opens.
 */
export async function listen(input: {
  home: string;
  url: string;
  selection: Selection;
  json?: boolean;
  events?: readonly string[];
  out: (line: string) => void;
  note: (line: string) => void;
  signal?: AbortSignal;
  holders?: SignetHolders;
}): Promise<number> {
  const note = (line: string) => input.note(redactSecrets(line));
  await holdGrantedSignets(input.home, input.url).catch(() => []);
  const { listeners, unread } = await heldListeners(input.home, input.url, input.holders);
  for (const { signetId, status } of unread)
    if (!input.selection.signetId || input.selection.signetId === signetId)
      note(
        `Left out Signet ${signetId}: ${status === 'revoked' ? 'revoked, Kingdom refuses it' : 'Kingdom did not describe it'} (kcp status)`,
      );
  const route = resolveListeners({ selection: input.selection, held: listeners });
  if (route.status !== 'resolved') throw Error(route.reason);
  const filters = input.events ?? [];
  const open = new Map<string, ListenChannel>();
  const sockets: SignetSocket[] = [];
  const listening = new Set<string>();
  const { promise: ended, resolve: end } = Promise.withResolvers<number>();
  const finish = (code: number) => {
    for (const socket of sockets) socket.close();
    end(code);
  };
  for (const listener of route.listeners) {
    const channels = listenChannels(listener, filters);
    if (!channels.length) continue;
    for (const channel of channels) open.set(channelKey(channel), channel);
    const socket = new SignetSocket({
      client: await SignetClient.fromFile(listener.credentialFile),
      onError: (error) =>
        note(
          `Signet ${listener.signetId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      eventStreams: {
        onEvent: (key, append, seq) => {
          const channel = open.get(channelKey(key));
          if (!channel || !eventKindAdmitted(filters, append.type)) return;
          const line = eventLine(channel, append, seq);
          input.out(
            input.json ? JSON.stringify(line) : formatEvent(line, { received: new Date() }),
          );
        },
        onOpened: (key) => {
          const channel = open.get(channelKey(key));
          if (!channel) return;
          const again = listening.has(channelKey(key));
          listening.add(channelKey(key));
          note(
            again
              ? `Listening again on ${channelLabel(channel)}; events published meanwhile were not delivered`
              : `Listening on ${channelLabel(channel)}`,
          );
        },
        onGap: (key, { after, seq }) => {
          const channel = open.get(channelKey(key));
          if (channel)
            note(
              `Gap on ${channelLabel(channel)}: seq ${after} to ${seq}; events in between were lost, or Kingdom restarted its count`,
            );
        },
        onClosed: (key, reason) => {
          const channel = open.get(channelKey(key));
          if (!channel) return;
          open.delete(channelKey(key));
          note(
            `Stopped listening on ${channelLabel(channel)}: ${reason ?? 'Kingdom gave no reason'}`,
          );
          if (!socket.heldEventChannels().length) socket.close();
          if (open.size) return;
          note('Every channel ended; nothing is left to listen on');
          finish(1);
        },
      },
    });
    for (const channel of channels) socket.openEventChannel(channel.resourceId);
    sockets.push(socket);
  }
  if (!open.size) throw Error(noChannelReason(route.listeners, filters));
  if (input.signal?.aborted) return 0;
  note(
    `Connecting to ${input.url}: ${plural(open.size, 'channel')} on ${plural(sockets.length, 'Signet')}; events are live only, nothing is replayed`,
  );
  const interrupted = () => finish(0);
  input.signal?.addEventListener('abort', interrupted, { once: true });
  for (const socket of sockets) socket.start();
  return ended.finally(() => input.signal?.removeEventListener('abort', interrupted));
}
