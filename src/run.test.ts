import { describe, expect, test } from 'bun:test';
import type { Measurement, Origin, Rule } from './rule';
import { run } from './run';

function stub(origin: Origin, held: boolean): Rule {
    const measurements: readonly Measurement[] = [
        { size: 1, cost: 1 },
        { size: 2, cost: 2 },
    ];
    return {
        name: 'subject',
        intention: 'The cost does not grow with the input size',
        origin,
        measure: async () => measurements,
        judge: () => ({
            held,
            exercised: true,
            magnitude: held ? 0 : 1,
            detail: 'The number of queries grows by ≈ 1 per item (1→1, 2→2)',
        }),
    };
}

describe('run', () => {
    test('a rule held asks no question', async () => {
        const [verdict] = await run([stub('declared', true)]);
        expect(verdict?.kind).toBe('held');
    });

    test('a written rule that is violated is a violation', async () => {
        const [verdict] = await run([stub('declared', false)]);
        expect(verdict?.kind).toBe('infraction');
    });

    test('a rule nobody wrote is a gap, not an accusation', async () => {
        const [verdict] = await run([stub('default', false)]);
        expect(verdict?.kind).toBe('lacuna');
        if (verdict?.kind !== 'lacuna') {
            throw new Error('unexpected verdict');
        }
        expect(verdict.question).toContain('No written rule forbids it. Is this intended?');
    });

    test('keeps the measurements so the report can show them', async () => {
        const [verdict] = await run([stub('default', false)]);
        expect(verdict?.measurements).toHaveLength(2);
    });

    test('judges each rule independently', async () => {
        const verdicts = await run([stub('declared', true), stub('default', false), stub('declared', false)]);
        expect(verdicts.map((verdict) => verdict.kind)).toEqual(['held', 'lacuna', 'infraction']);
    });
});
