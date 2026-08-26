import type { Order } from './gateway';

/** A synchronous map: nothing leaves the process. */
export function labels(ids: readonly string[]): readonly string[] {
    // @expect none
    return ids.map((id) => id.trim());
}

/** A synchronous loop over a literal: its length is written in the code. */
export function weekend(): number {
    let days = 0;
    // @expect none
    for (const day of [6, 7]) {
        days += day;
    }
    return days;
}

/** A shape that carries a count without being a page: no `total`. */
export function summary(orders: readonly Order[]): { items: readonly Order[]; count: number } {
    // @expect none
    return { items: orders, count: orders.length };
}
