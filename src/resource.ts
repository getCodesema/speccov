import type { Gauge } from './gauge';
import { requireIntention, type Judgement, type Measurement, type Origin, type Rule } from './rule';

export type ResourceOptions = {
    readonly name: string;
    readonly intention?: string;
    /** Unit observed, PLURAL. */
    readonly unit?: string;
    /** Tolerated peak. Choosing it is writing a rule — hence `origin: 'declared'`. */
    readonly ceiling: number;
    readonly sizes?: readonly number[];
    readonly gauge: Gauge;
    readonly subject: (size: number) => unknown;
    readonly origin?: Origin;
};

const DEFAULT_SIZES = [1, 4, 16] as const;

/**
 * Resource rule: the observed peak stays under a ceiling, whatever the input.
 *
 * This is the one that catches an unbounded `Promise.all`: concurrency there follows the
 * size of the collection, so it crosses any ceiling as soon as the data grows.
 */
export function resource(options: ResourceOptions): Rule {
    const unit = options.unit ?? 'concurrent operations';
    const sizes = options.sizes ?? DEFAULT_SIZES;
    const intention = requireIntention(options.name, options.intention ?? `Peak ${unit} never exceeds ${options.ceiling}`);

    if (!Number.isFinite(options.ceiling) || options.ceiling < 1) {
        throw new Error(`speccov: invalid ceiling (${options.ceiling}) for “${options.name}”, expected an integer of 1 or more.`);
    }

    return {
        name: options.name,
        intention,
        origin: options.origin ?? 'declared',

        // A ceiling of 1 does not tighten: 0 would forbid every operation.
        tighten: () => (options.ceiling > 1 ? resource({ ...options, ceiling: options.ceiling - 1 }) : undefined),

        async measure(): Promise<readonly Measurement[]> {
            const measurements: Measurement[] = [];
            for (const size of sizes) {
                options.gauge.reset();
                await options.subject(size);
                measurements.push({ size, cost: options.gauge.peak });
            }
            return measurements;
        },

        judge(measurements): Judgement {
            if (measurements.length === 0) {
                throw new Error(`speccov: no measurement for “${options.name}”.`);
            }
            const peak = Math.max(...measurements.map(({ cost }) => cost));
            const series = measurements.map(({ size, cost }) => `${size}→${cost}`).join(', ');
            // A zero peak: nothing was consumed, so no ceiling was ever exercised.
            const exercised = peak > 0;
            if (peak <= options.ceiling) {
                return {
                    held: true,
                    exercised,
                    magnitude: 0,
                    detail: `Peak of ${peak} ${unit}, ceiling ${options.ceiling} (${series})`,
                };
            }
            return {
                held: false,
                exercised,
                magnitude: peak - options.ceiling,
                detail: `Peak of ${peak} ${unit} against a ceiling of ${options.ceiling} (${series})`,
            };
        },
    };
}
