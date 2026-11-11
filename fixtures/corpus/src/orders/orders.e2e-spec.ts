import { loadOrder } from './gateway';

/**
 * A real fan-out, in a test file. The pass sets tests aside: what a suite does to its own
 * doubles guarantees nothing about production, and counting it would drown the report.
 */
export async function suite(ids: readonly string[]): Promise<void> {
    // @expect none
    await Promise.all(ids.map((id) => loadOrder(id)));
}
