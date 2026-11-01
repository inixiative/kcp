import { SignetClient, SignetHttpError } from '@inixiative/signet';
import {
  type ParsedSignetDescription,
  parseSignetDescription,
  type SignetHolder,
  signetHolderSchema,
} from '@inixiative/signet/contracts';
import { z } from 'zod';

/**
 * A held Signet as Kingdom's extended `access/describe` reports it, with its `holder` (null for a
 * person-held Signet). Read per entry (`parseSignetDescription`), so a resource this package can't
 * read costs that resource, never the holder.
 */
export const parseHeldSignetDescription = (value: unknown) => ({
  ...parseSignetDescription(value),
  holder:
    z.object({ holder: signetHolderSchema.nullable().optional() }).parse(value).holder ?? null,
});

export interface HolderView {
  /** `described`: Kingdom answered; `revoked`: Kingdom refused the Signet (403); `unavailable`: no answer. */
  status: 'described' | 'revoked' | 'unavailable';
  holder: SignetHolder | null;
  description: ParsedSignetDescription | null;
  checkedAt: number;
}

/** One held Signet: its credential file and the Kingdom and Signet it presents. */
export type HeldSignetRef = { url: string; signetId: string; credentialFile: string };

type Describe = (signet: HeldSignetRef) => Promise<unknown>;

const describeWithSignet: Describe = async ({ url, credentialFile, signetId }) =>
  new SignetClient(url, credentialFile, signetId).post('describe', { signetId }, undefined, {
    timeoutMs: 5_000,
  });

/**
 * Descriptions per held Signet, cached: read at most once per `ttlMs`, again after the
 * Installation socket reports a change (`stale()`), and shared by concurrent readers.
 */
export class SignetHolders {
  private cache = new Map<string, { view: HolderView; stale: boolean }>();
  private inflight = new Map<string, Promise<HolderView>>();
  private readonly ttlMs: number;
  private readonly describe: Describe;
  constructor(options: { ttlMs?: number; describe?: Describe } = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.describe = options.describe ?? describeWithSignet;
  }

  /** The Installation snapshot changed: what Kingdom holds may have too. */
  stale() {
    for (const entry of this.cache.values()) entry.stale = true;
  }

  forget(credentialFile: string) {
    this.cache.delete(credentialFile);
  }

  /** The cached view when fresh; otherwise a new read, waiting at most `waitMs` before answering with the last one. */
  async get(signet: HeldSignetRef, waitMs = 3_000): Promise<HolderView> {
    const id = signet.credentialFile;
    const cached = this.cache.get(id);
    if (cached && !cached.stale && Date.now() - cached.view.checkedAt < this.ttlMs)
      return cached.view;
    let read = this.inflight.get(id);
    if (!read) {
      read = this.read(signet).then((view) => {
        this.cache.set(id, { view, stale: false });
        return view;
      });
      read.finally(() => this.inflight.delete(id)).catch(() => {});
      this.inflight.set(id, read);
    }
    const fallback: HolderView = cached?.view ?? {
      status: 'unavailable',
      holder: null,
      description: null,
      checkedAt: Date.now(),
    };
    return Promise.race([read, Bun.sleep(waitMs).then(() => fallback)]);
  }

  private async read(signet: HeldSignetRef): Promise<HolderView> {
    const checkedAt = Date.now();
    try {
      const description = parseHeldSignetDescription(await this.describe(signet));
      return { status: 'described', holder: description.holder, description, checkedAt };
    } catch (error) {
      const status =
        error instanceof SignetHttpError && error.status === 403 ? 'revoked' : 'unavailable';
      return { status, holder: null, description: null, checkedAt };
    }
  }
}
