import { chargeOrder, loadOrder, type Order } from './gateway';

/**
 * The frontier of the module: what comes in here was typed by no compiler. Below it, the
 * questions the scan asks about primitives, and the shapes that close their own domain.
 */

// @expect unbounded-primitive
export async function byPage(page: number): Promise<readonly Order[]> {
    return [await loadOrder(String(page))];
}

// Both values only feed a computation: neither leaves the process, so nothing is asked.
// @expect none
export function label(reference: string, quantity: number): string {
    return `${reference} x${quantity}`;
}

// The same two values, handed to a call that leaves the process: two questions.
// @expect unbounded-primitive, unbounded-primitive
export async function charge(reference: string, quantity: number): Promise<void> {
    await chargeOrder(reference, quantity);
}

/** A closed union: the compiler already answered. */
// @expect none
export function sortBy(field: 'date' | 'total'): string {
    return field;
}

/** A boolean is finite, and an optional is left to a later pass. */
// @expect none
export function render(compact: boolean, width?: number): string {
    return compact ? `${width ?? 0}` : 'full';
}

/** Not exported: inside the module the caller is typed, so the guarantee holds. */
// @expect none
function checksum(seed: number): number {
    return seed * 2;
}

/** A member, not a function declaration: outside what this pass reads today. */
export class Orders {
    // @expect none
    async at(index: number): Promise<Order | undefined> {
        return await loadOrder(String(index + checksum(1)));
    }
}
