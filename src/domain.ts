/**
 * The cartesian product of a finite domain, from the simplest case to the most complex.
 *
 * A ban that only tries a hand-written list finds nothing beyond what its author already
 * suspected. The scope defect in `AreaScopeService` was found because someone had thought
 * to write `{ role: 'org_admin', adminAreaId: null }` — not because the tool had gone
 * looking for it.
 *
 * Four roles and two area states make eight actors. All eight are free: the predicate is
 * pure, the loop runs in under a millisecond. There is no reason at all to pick a subset
 * of them.
 */

/** For each field, the values it can take. The first one is the simplest. */
export type Domain<T> = { readonly [K in keyof T]: readonly T[K][] };

/**
 * A guard against the typo, not against exhaustiveness.
 *
 * Twenty values over eight fields make twenty-five billion cases: that is no longer a
 * domain, it is a typing mistake. We throw and name it rather than sampling a share of it
 * in silence — a ban exercised over a tenth of its domain announces a green light it does
 * not have.
 */
const REFUSAL_THRESHOLD = 1_000_000;

/**
 * Every case of the domain, ordered by distance from the simplest combination.
 *
 * The ordering carries the whole job: the first counterexample met is the one that deviates
 * least from the base case, hence **the smallest**. No shrinking to write, no second pass —
 * `forbidden()` already keeps the first one, and it turns out to be the right one.
 */
export function allOf<T extends object>(domain: Domain<T>): readonly T[] {
    const fields = Object.keys(domain) as (keyof T)[];
    if (fields.length === 0) {
        throw new Error('speccov: allOf() received no field. An empty domain proves nothing.');
    }

    let total = 1;
    for (const field of fields) {
        const values = domain[field];
        if (values.length === 0) {
            throw new Error(`speccov: allOf() got no value for “${String(field)}”. A field without a value has no case.`);
        }
        total *= values.length;
        if (total > REFUSAL_THRESHOLD) {
            throw new Error(
                `speccov: allOf() would build more than ${REFUSAL_THRESHOLD.toLocaleString('en-US')} cases. Narrow the domain — this is a typo, not a domain.`,
            );
        }
    }

    const cases: { value: T; distance: number }[] = [];
    const walk = (index: number, built: Partial<T>, distance: number): void => {
        const field = fields[index];
        if (field === undefined) {
            cases.push({ value: { ...built } as T, distance });
            return;
        }
        const values = domain[field];
        values.forEach((value, rank) => {
            walk(index + 1, { ...built, [field]: value }, distance + (rank === 0 ? 0 : 1));
        });
    };
    walk(0, {}, 0);

    // Stable sort: at equal distance, the order the domain was written in is preserved.
    return cases.sort((left, right) => left.distance - right.distance).map(({ value }) => value);
}
