import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  GENERATION_LOCK_STALE_MS,
  generateForArticle,
} from "./variant.server";

/**
 * Server-side generation queue.
 *
 * Enqueueing marks Article.queuedAt and returns immediately; a background
 * worker in this process starts EVERY queued article right away (no
 * concurrency cap - the merchant's explicit choice) using the shop's stored
 * offline session, and keeps going regardless of what the admin does in the
 * browser. Very large bursts may hit Anthropic/Shopify rate limits; the
 * model client retries with backoff and anything that still fails lands as
 * a retryable "Failed" article. Claiming an article (dequeue + generatingAt
 * lock) is one atomic write, so an article can never be double-queued into
 * a duplicate run.
 *
 * Deployment assumption: a single server process (matches the SQLite
 * datasource). The worker state is a globalThis singleton so dev-mode module
 * reloads never start a second loop.
 */

const SWEEP_INTERVAL_MS = 15_000;
// A slot may never outlive the generation lock's staleness window.
const RUN_TIMEOUT_MS = 12 * 60 * 1000;

type QueueState = {
  inFlight: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
};

const globalStore = globalThis as typeof globalThis & {
  __pageTailorQueue?: QueueState;
};

function state(): QueueState {
  if (!globalStore.__pageTailorQueue) {
    globalStore.__pageTailorQueue = { inFlight: new Set(), timer: null, ticking: false };
  }
  return globalStore.__pageTailorQueue;
}

function lockStaleCutoff(): Date {
  return new Date(Date.now() - GENERATION_LOCK_STALE_MS);
}

/** Start the periodic sweep (idempotent). Called lazily on first use. */
function ensureWorker(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => {
    void tick();
  }, SWEEP_INTERVAL_MS);
  // Never keep the process alive just for the sweep.
  if (typeof s.timer.unref === "function") s.timer.unref();
}

/**
 * Queue articles for generation. Each enqueue is a single guarded write, so
 * racing enqueues (double-clicks, two tabs) can never double-queue. Articles
 * already queued, currently generating, or currently occupying a worker slot
 * are skipped.
 */
export async function enqueueGeneration(
  shop: string,
  articleIds: string[],
): Promise<{ queued: number; skipped: number }> {
  ensureWorker();
  const s = state();
  let queued = 0;
  let skipped = 0;
  for (const id of articleIds) {
    if (s.inFlight.has(id)) {
      skipped++;
      continue;
    }
    const result = await prisma.article.updateMany({
      where: {
        id,
        shop,
        queuedAt: null,
        OR: [
          { generatingAt: null },
          { generatingAt: { lt: lockStaleCutoff() } },
        ],
      },
      data: { queuedAt: new Date(), errorMessage: null },
    });
    if (result.count === 1) queued++;
    else skipped++;
  }
  // Kick the worker right away instead of waiting for the next sweep.
  void tick();
  return { queued, skipped };
}

/** One scheduling pass: start every queued article that isn't already
 *  running. No concurrency cap. */
async function tick(): Promise<void> {
  const s = state();
  // A single pass at a time: the pass itself is fast (it only claims and
  // spawns), so a simple reentrancy flag is enough.
  if (s.ticking) return;
  s.ticking = true;
  try {
    const eligible = await prisma.article.findMany({
      where: {
        queuedAt: { not: null },
        id: { notIn: [...s.inFlight] },
        // Never pick a row whose generation lock is still live (e.g. a
        // pre-restart run that is somehow still going elsewhere).
        OR: [
          { generatingAt: null },
          { generatingAt: { lt: lockStaleCutoff() } },
        ],
      },
      orderBy: { queuedAt: "asc" },
    });
    for (const next of eligible) {
      if (s.inFlight.has(next.id)) continue;
      s.inFlight.add(next.id);
      void runOne(next.id, next.shop).finally(() => {
        s.inFlight.delete(next.id);
      });
    }
  } catch (error) {
    console.error("Generation queue tick failed", error);
  } finally {
    s.ticking = false;
  }
}

function errorMessageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof Response !== "undefined" && error instanceof Response) {
    return `Could not reach Shopify (HTTP ${error.status}). The shop's access token may need refreshing - open the app and retry.`;
  }
  return String(error);
}

async function runOne(articleId: string, shop: string): Promise<void> {
  try {
    // Atomic claim: leave the queue AND take the generation lock in one
    // write. If someone dequeued the article (or a live lock appeared) in
    // the meantime, count is 0 and there is nothing to do.
    const claim = await prisma.article.updateMany({
      where: {
        id: articleId,
        queuedAt: { not: null },
        OR: [
          { generatingAt: null },
          { generatingAt: { lt: lockStaleCutoff() } },
        ],
      },
      data: { queuedAt: null, generatingAt: new Date() },
    });
    if (claim.count === 0) return;

    const work = async () => {
      const { admin } = await unauthenticated.admin(shop);
      await generateForArticle(admin, shop, articleId, {
        lockAlreadyHeld: true,
      });
    };
    // The timeout frees the worker slot; a zombie run keeps holding the DB
    // lock until it settles, and tick() never picks live-locked rows, so a
    // freed slot can never cause a duplicate run.
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("Generation timed out after 12 minutes. Retry.")),
          RUN_TIMEOUT_MS,
        );
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
  } catch (error) {
    // generateForArticle records its own failures; this backstop also covers
    // errors thrown BEFORE it starts (missing offline session, token refresh
    // failure) and the slot timeout. Mirror its two-write pattern so a live
    // approved variant surfaces the failed background run without ever
    // being taken down.
    console.error(`Queued generation failed for article ${articleId}`, error);
    const message = errorMessageFrom(error);
    await prisma.article
      .updateMany({
        where: { id: articleId, status: { not: "approved" } },
        data: { status: "error", errorMessage: message },
      })
      .catch(() => {});
    await prisma.article
      .updateMany({
        where: { id: articleId, status: "approved" },
        data: { errorMessage: message },
      })
      .catch(() => {});
  }
}

/**
 * Recovery sweep for queued work left over from a previous process (server
 * restart mid-queue). Also called from loaders; cheap when there is nothing
 * to do.
 */
export function kickGenerationQueue(): void {
  ensureWorker();
  void tick();
}

// Boot recovery: restart the queue shortly after the server process starts,
// so work queued before a restart resumes without anyone opening the admin.
// globalThis-guarded so dev-mode module reloads don't schedule it twice.
const bootStore = globalThis as typeof globalThis & {
  __pageTailorQueueBooted?: boolean;
};
if (!bootStore.__pageTailorQueueBooted) {
  bootStore.__pageTailorQueueBooted = true;
  const bootTimer = setTimeout(() => kickGenerationQueue(), 5_000);
  if (typeof bootTimer.unref === "function") bootTimer.unref();
}
