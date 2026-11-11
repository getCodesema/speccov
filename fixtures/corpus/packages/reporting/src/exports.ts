/**
 * A second scope, with its own tsconfig: a monorepo has one per package. Its sites must land
 * in the same report, addressed from the root the scan was given.
 */

declare function send(row: string): Promise<void>;

// @expect unbounded-primitive
export async function exportRows(rows: readonly string[], separator: string): Promise<void> {
    // @expect awaited-in-loop
    for (const row of rows) {
        await send(`${row}${separator}`);
    }
}
