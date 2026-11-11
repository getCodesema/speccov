import { requireIntention, type Judgement, type Measurement, type Origin, type Rule } from './rule';

export type MetamorphicOptions<V, O> = {
    readonly name: string;
    /** Mandatory: the expected relation cannot be guessed. */
    readonly intention: string;
    /** The variants to compare. At least two — comparing a thing to nothing proves nothing. */
    readonly variants: readonly V[];
    /** What is observed, and what must stay identical from one variant to the next. */
    readonly observe: (variant: V) => Promise<O> | O;
    readonly describe?: (variant: V) => string;
    readonly origin?: Origin;
};

/**
 * Metamorphic rule: one observation stays invariant from one variant to the next.
 *
 * It does not say which value is the right one — often we do not know. It only says the
 * value must not change. This is what catches a `total` that follows the page instead of
 * the full result set.
 */
export function metamorphic<V, O>(options: MetamorphicOptions<V, O>): Rule {
    const intention = requireIntention(options.name, options.intention);
    const describe = options.describe ?? ((variant: V) => JSON.stringify(variant));

    if (options.variants.length < 2) {
        throw new Error(`speccov: “${options.name}” needs at least two variants, got ${options.variants.length}.`);
    }

    /** Filled by `measure()`, read by `judge()`. */
    let observed: readonly string[] = [];

    return {
        name: options.name,
        intention,
        origin: options.origin ?? 'declared',

        async measure(): Promise<readonly Measurement[]> {
            const seen: string[] = [];
            for (const variant of options.variants) {
                seen.push(`${describe(variant)} → ${JSON.stringify(await options.observe(variant))}`);
            }
            observed = seen;
            const distinct = new Set(seen.map((entry) => entry.split(' → ').at(-1))).size;
            return [{ size: options.variants.length, cost: distinct }];
        },

        judge(measurements): Judgement {
            const [measurement] = measurements;
            if (measurement === undefined) {
                throw new Error(`speccov: no measurement for “${options.name}”.`);
            }
            const { size, cost } = measurement;
            // The constructor already refuses fewer than two variants: an invariance has
            // always had something to compare against. The hole is closed upstream, not here.
            const exercised = true;
            if (cost <= 1) {
                return { held: true, exercised, magnitude: 0, detail: `Same observation across ${size} variants` };
            }
            return {
                held: false,
                exercised,
                magnitude: cost - 1,
                detail: `${cost} different values across ${size} variants: ${observed.join(' ; ')}`,
            };
        },
    };
}
