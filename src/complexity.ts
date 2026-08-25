import type { Counter } from './counter';
import { EPSILON, measureGrowth } from './growth';
import { requireIntention, type Judgement, type Measurement, type Origin, type Rule } from './rule';

export type ComplexityOptions = {
    readonly name: string;
    /** Readable sentence. Generated from `unit` when absent — a default rule carries its own. */
    readonly intention?: string;
    /** Successive input sizes. At least two distinct values. */
    readonly sizes?: readonly number[];
    /** Unit counted, PLURAL: it only ever appears after "the number of". */
    readonly unit?: string;
    /** Tolerated cost per item. Zero by default: the cost must stay constant. */
    readonly perItemTolerance?: number;
    readonly origin?: Origin;
    readonly counter: Counter;
    readonly subject: (size: number) => unknown;
};

const DEFAULT_SIZES = [1, 2, 4, 8, 16] as const;

/**
 * Complexity rule: the cost does not grow with the input size.
 *
 * This is the rule nobody needs to write — hence `origin: 'default'`. It catches N+1s and
 * any fan-out proportional to the data.
 */
export function complexity(options: ComplexityOptions): Rule {
    const unit = options.unit ?? 'operations';
    const sizes = options.sizes ?? DEFAULT_SIZES;
    const tolerance = options.perItemTolerance ?? 0;
    const intention = requireIntention(
        options.name,
        options.intention ?? `The number of ${unit} does not grow with the input size`,
    );

    return {
        name: options.name,
        intention,
        origin: options.origin ?? 'default',

        // A zero tolerance is the default, not a decision: nothing to tighten.
        tighten: () => (tolerance > 0 ? complexity({ ...options, perItemTolerance: 0 }) : undefined),

        async measure(): Promise<readonly Measurement[]> {
            const measurements: Measurement[] = [];
            for (const size of sizes) {
                options.counter.reset();
                await options.subject(size);
                measurements.push({ size, cost: options.counter.hits });
            }
            return measurements;
        },

        judge(measurements): Judgement {
            const { perItem, series } = measureGrowth(measurements);
            // A series of zeros gives a zero slope. That is constancy by absence:
            // the code did nothing, the rule saw nothing.
            const exercised = measurements.some(({ cost }) => cost > 0);
            if (perItem <= tolerance + EPSILON) {
                return { held: true, exercised, magnitude: perItem, detail: `The number of ${unit} stays constant (${series})` };
            }
            return {
                held: false,
                exercised,
                magnitude: perItem,
                detail: `The number of ${unit} grows by ≈ ${round(perItem)} per item (${series})`,
            };
        },
    };
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
