import { chargeOrder, loadOrder, type Order } from './gateway';

/**
 * A pool of fixed width. The ceiling is `concurrency`, so the fan-out is not the site of the
 * question: the parameter is, and it carries its own. Note what is not claimed here, namely
 * `async-per-item`: a width the code writes says nothing about a number that should grow.
 */
// @expect unbounded-primitive
export async function drainPool(concurrency: number): Promise<void> {
    // @expect bounded-fanout
    await Promise.all(Array.from({ length: concurrency }, async () => await chargeOrder('x', 1)));
}

/** Three named calls: the width is the source itself. */
export async function warmUp(): Promise<void> {
    // @expect bounded-fanout
    await Promise.all([loadOrder('a'), loadOrder('b'), loadOrder('c')]);
}

/** Work started elsewhere, gathered here: waiting on it opens no outgoing call. */
const inflight = new Map<string, Promise<Order>>();

export async function settle(): Promise<readonly Order[]> {
    // @expect in-flight-drain
    return await Promise.all([...inflight.values()]);
}

/** The same drain without the detour through an array: the source is what decides, not the shape. */
export async function settleDirectly(): Promise<readonly Order[]> {
    // @expect in-flight-drain
    return await Promise.all(inflight.values());
}

/** The same drain, decorated on the way: the receiver is what says where it comes from. */
export async function settleQuietly(): Promise<readonly (Order | undefined)[]> {
    // @expect in-flight-drain
    return await Promise.all([...inflight.values()].map(async (pending) => await pending.catch(() => undefined)));
}

/**
 * A limit, written here so that lifting it is a decision.
 *
 * Only `all` and `allSettled` are classified today. `race` and `any` open exactly as many
 * outgoing calls as `all` does, since waiting on the first to answer starts every one of them:
 * the fan-out below is real and no question is asked about its ceiling.
 */
export async function first(): Promise<Order> {
    // @expect none
    return await Promise.race([...inflight.values()]);
}

export async function firstOf(ids: readonly string[]): Promise<Order> {
    // Only the growth question comes out. The concurrency one, which `all` would have raised
    // on this very line, does not.
    // @expect async-per-item
    return await Promise.race(ids.map(async (id) => await loadOrder(id)));
}

/** A batch of fixed size cut out of a collection that has none. */
const BATCH = 25;

export async function firstBatch(ids: readonly string[]): Promise<readonly Order[]> {
    // @expect bounded-fanout
    return await Promise.all(ids.slice(0, BATCH).map(async (id) => await loadOrder(id)));
}

/** Awaiting one promise already in flight is neither a fan-out nor a drain. */
// @expect unbounded-primitive
export async function one(key: string): Promise<Order | undefined> {
    // @expect none
    return await inflight.get(key);
}
