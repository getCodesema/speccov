/** An old build kept next to the sources. The walk does not go in, so nothing is read twice. */
// @expect none
export async function stale(ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map(async (id) => await fetch(id)));
}
