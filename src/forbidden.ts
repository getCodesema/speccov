import { requireIntention, type Judgement, type Measurement, type Origin, type Rule } from './rule';

export type ForbiddenOptions<T> = {
    readonly name: string;
    /** Mandatory: a ban is domain knowledge, no default sentence can state it. */
    readonly intention: string;
    /** The inputs to exercise. Hand-written list, fast-check, faker — take your pick. */
    readonly cases: Iterable<T> | (() => Iterable<T>);
    /** True when the input produces what is forbidden. */
    readonly forbids: (value: T) => Promise<boolean> | boolean;
    /** How to name a counterexample in the report. */
    readonly describe?: (value: T) => string;
    readonly origin?: Origin;
};

/**
 * Ban rule: no input must ever produce this behaviour.
 *
 * It is the most demanding kind of rule, because it quantifies over the whole input space
 * instead of illustrating a few happy cases.
 */
export function forbidden<T>(options: ForbiddenOptions<T>): Rule {
    const intention = requireIntention(options.name, options.intention);
    const describe = options.describe ?? ((value: T) => JSON.stringify(value));

    /** Filled by `measure()`, read by `judge()`: `run()` guarantees that order. */
    let firstCounterexample: string | undefined;

    return {
        name: options.name,
        intention,
        origin: options.origin ?? 'declared',

        async measure(): Promise<readonly Measurement[]> {
            firstCounterexample = undefined;
            const cases = typeof options.cases === 'function' ? options.cases() : options.cases;
            let tried = 0;
            let violations = 0;

            for (const value of cases) {
                tried += 1;
                if (await options.forbids(value)) {
                    violations += 1;
                    firstCounterexample ??= describe(value);
                }
            }
            if (tried === 0) {
                throw new Error(`speccov: “${options.name}” tried no input. A ban without cases proves nothing.`);
            }
            return [{ size: tried, cost: violations }];
        },

        judge(measurements): Judgement {
            const [measurement] = measurements;
            if (measurement === undefined) {
                throw new Error(`speccov: no measurement for “${options.name}”.`);
            }
            const { size, cost } = measurement;
            // `measure()` already refuses zero input: the predicate necessarily judged something real.
            const exercised = size > 0;
            if (cost === 0) {
                return {
                    held: true,
                    exercised,
                    magnitude: 0,
                    detail: `No counterexample across ${size} input(s) tried`,
                };
            }
            return {
                held: false,
                exercised,
                magnitude: cost,
                detail: `${cost} counterexample(s) across ${size} input(s), including ${firstCounterexample ?? 'unknown'}`,
            };
        },
    };
}
