import { chargeOrder, loadOrder, type Order } from './gateway';

/** One outgoing call per identifier, all in flight at once. */
export async function loadAll(ids: readonly string[]): Promise<readonly Order[]> {
    // @expect unbounded-fanout, async-per-item
    return await Promise.all(ids.map((id) => loadOrder(id)));
}

/** One outgoing call per identifier, in series: the wait follows the collection. */
export async function chargeEach(ids: readonly string[]): Promise<void> {
    // @expect awaited-in-loop
    for (const id of ids) {
        await chargeOrder(id, 1);
    }
}

/**
 * A page, and the size of the whole.
 *
 * The fan-out is called bounded because `slice` fixes its width; the ceiling question is
 * carried by `limit` itself, which takes the whole numeric domain. Two markers, one shape.
 */
// @expect unbounded-primitive
export async function page(ids: readonly string[], limit: number): Promise<{ items: readonly Order[]; total: number }> {
    // @expect bounded-fanout
    const items = await Promise.all(ids.slice(0, limit).map((id) => loadOrder(id)));
    // @expect paginated-return
    return { items, total: ids.length };
}
