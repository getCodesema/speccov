import { describe, expect, test } from 'bun:test';
import { complexity } from './complexity';
import { forbidden } from './forbidden';
import { metamorphic } from './metamorphic';
import { resource } from './resource';
import { run } from './run';
import { Counter } from './counter';
import { Gauge } from './gauge';

/**
 * Vacuity: a rule satisfied for a trivial reason. Before this guard, two of these four
 * rules returned a green light without having observed anything.
 */
describe('vacuity', () => {
    test('an invariance without two observations is refused at construction', () => {
        expect(() =>
            metamorphic({
                name: 'total-stable',
                intention: 'The total does not depend on the page',
                variants: [{ page: 1 }],
                observe: async () => 7,
            }),
        ).toThrow('at least two variants');
    });

    test('a ceiling nothing ever came close to has capped nothing', async () => {
        const gauge = new Gauge();
        const [verdict] = await run([
            resource({
                name: 'concurrent-calls',
                intention: 'At most 5 outbound calls in flight',
                ceiling: 5,
                unit: 'calls',
                sizes: [1, 2],
                subject: () => undefined,
                gauge,
            }),
        ]);

        expect(verdict?.kind).toBe('vacuous');
    });

    test('a complexity measured over zero costs is constant by absence', async () => {
        const counter = new Counter();
        const [verdict] = await run([
            complexity({
                name: 'queries',
                intention: 'The number of queries does not grow with the size',
                unit: 'queries',
                sizes: [1, 2, 3],
                subject: () => undefined,
                counter,
            }),
        ]);

        expect(verdict?.kind).toBe('vacuous');
    });

    test('a rule genuinely exercised still holds', async () => {
        const [verdict] = await run([
            forbidden({
                name: 'no-negative',
                intention: 'No negative amount gets through',
                cases: [1, 2, 3],
                forbids: (value: number) => value < 0,
            }),
        ]);

        expect(verdict?.kind).toBe('held');
    });

    test('a rule never exercised does not fail CI', async () => {
        const { exitCode } = await import('./report');
        const gauge = new Gauge();
        const verdicts = await run([
            resource({
                name: 'concurrent-calls',
                intention: 'At most 5 outbound calls in flight',
                ceiling: 5,
                unit: 'calls',
                sizes: [1, 2],
                subject: () => undefined,
                gauge,
            }),
        ]);

        expect(exitCode(verdicts)).toBe(0);
    });
});

/**
 * Rule mutation: the threshold is tightened one notch and the SAME measurements are judged
 * again. A rule that falls then sat right on the line — threshold chosen, or fitted after?
 */
describe('margin at the threshold', () => {
    function ceilingRule(ceiling: number, peak: number) {
        const gauge = new Gauge();
        return resource({
            name: 'calls',
            intention: `At most ${ceiling} concurrent calls`,
            ceiling,
            unit: 'calls',
            sizes: [1],
            subject: () => Promise.all(Array.from({ length: peak }, () => gauge.track(async () => {}))),
            gauge,
        });
    }

    test('a peak sitting exactly on the ceiling is reported with no margin', async () => {
        const [verdict] = await run([ceilingRule(3, 3)]);

        expect(verdict?.kind).toBe('borderline');
    });

    test('a peak under the ceiling simply holds', async () => {
        const [verdict] = await run([ceilingRule(5, 3)]);

        expect(verdict?.kind).toBe('held');
    });

    test('a ceiling of 1 does not tighten: nothing left to question', async () => {
        const [verdict] = await run([ceilingRule(1, 1)]);

        expect(verdict?.kind).toBe('held');
    });

    function slopeRule(tolerance: number) {
        const counter = new Counter();
        return complexity({
            name: 'queries',
            intention: 'The number of queries does not grow with the size',
            unit: 'queries',
            sizes: [1, 2, 3],
            perItemTolerance: tolerance,
            // One query per item: a slope of exactly 1.
            subject: (size: number) => {
                for (let i = 0; i < size; i += 1) {
                    counter.hit();
                }
            },
            counter,
        });
    }

    test('a tolerance sitting exactly on the observed slope is reported', async () => {
        const [verdict] = await run([slopeRule(1)]);

        expect(verdict?.kind).toBe('borderline');
    });

    test('a zero tolerance is the default, not a fitted threshold', async () => {
        const [verdict] = await run([slopeRule(0)]);

        // The slope of 1 exceeds the tolerance of 0. `complexity` being a default rule,
        // breaking it is a gap — a question — not an infraction.
        expect(verdict?.kind).toBe('lacuna');
    });

    test('a rule with no threshold to tighten never produces a no-margin verdict', async () => {
        const [verdict] = await run([
            forbidden({
                name: 'no-negative',
                intention: 'No negative amount gets through',
                cases: [1, 2],
                forbids: (value: number) => value < 0,
            }),
        ]);

        expect(verdict?.kind).toBe('held');
    });

    test('a rule with no margin does not fail CI', async () => {
        const { exitCode } = await import('./report');

        expect(exitCode(await run([ceilingRule(3, 3)]))).toBe(0);
    });
});
