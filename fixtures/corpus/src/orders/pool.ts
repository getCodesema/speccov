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

/** A drain is a drain whatever gathers it: `race` waits on promises it did not start. */
export async function first(): Promise<Order> {
    // @expect in-flight-drain
    return await Promise.race([...inflight.values()]);
}

/**
 * And a fan-out is a fan-out whatever waits on it. Awaiting the first answer starts every
 * call all the same, so both questions are open here, exactly as under `Promise.all`.
 */
export async function firstOf(ids: readonly string[]): Promise<Order> {
    // @expect unbounded-fanout, async-per-item
    return await Promise.race(ids.map(async (id) => await loadOrder(id)));
}

/** A batch of fixed size cut out of a collection that has none. */
const BATCH = 25;

export async function firstBatch(ids: readonly string[]): Promise<readonly Order[]> {
    // @expect bounded-fanout
    return await Promise.all(ids.slice(0, BATCH).map(async (id) => await loadOrder(id)));
}

/** `any` is read the same way, and a width the code writes closes the ceiling question. */
export async function anyOf(ids: readonly string[]): Promise<Order> {
    // @expect bounded-fanout
    return await Promise.any(ids.slice(0, BATCH).map(async (id) => await loadOrder(id)));
}

/** Awaiting one promise already in flight is neither a fan-out nor a drain. */
// @expect unbounded-primitive
export async function one(key: string): Promise<Order | undefined> {
    // @expect none
    return await inflight.get(key);
}
