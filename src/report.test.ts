import { describe, expect, test } from 'bun:test';
import { exitCode, report } from './report';
import type { Measurement, Rule, Verdict } from './rule';

const measurements: readonly Measurement[] = [{ size: 1, cost: 1 }];
const rule: Rule = {
    name: 'list-admin-users · SQL queries',
    intention: 'The number of SQL queries does not grow with the input size',
    origin: 'default',
    measure: async () => measurements,
    judge: () => ({ held: false, exercised: true, magnitude: 1, detail: 'does not matter' }),
};

const lacuna: Verdict = {
    kind: 'lacuna',
    rule,
    measurements,
    magnitude: 1,
    detail: 'grows by ≈ 1 per item',
    question: 'The number of queries grows. Is this intended?',
};
const infraction: Verdict = { kind: 'infraction', rule, measurements, magnitude: 1, detail: 'grows by ≈ 1 per item' };
const held: Verdict = { kind: 'held', rule, measurements, magnitude: 0, detail: 'constant' };

describe('report', () => {
    test('shows the question, not the raw measurement', () => {
        expect(report([lacuna])).toContain('The number of queries grows. Is this intended?');
    });

    test('names the rule concerned', () => {
        expect(report([lacuna])).toContain('list-admin-users · SQL queries');
    });

    test('successes fit on a single line', () => {
        expect(report([held, held])).toContain('✓ 2 rules held');
    });

    test('agrees the singular', () => {
        expect(report([held])).toContain('✓ 1 rule held');
    });

    test('recalls the violated intention on a violation', () => {
        expect(report([infraction])).toContain('The number of SQL queries does not grow with the input size');
    });

    /**
     * A rule concludes only about the sizes it tried. A report that keeps that bound quiet
     * reads as "cost never grows" — the lie by omission levelled at 90% coverage.
     */
    test('declares the window of sizes actually tried', () => {
        const wide: Verdict = {
            ...held,
            measurements: [
                { size: 1, cost: 1 },
                { size: 16, cost: 16 },
                { size: 4, cost: 4 },
            ],
        };

        expect(report([wide])).toContain('Input sizes tried: 1, 4, 16 — nothing beyond 16.');
    });

    test('a rule that measured nothing is named, not silenced', () => {
        const blind: Verdict = { ...held, measurements: [] };

        expect(report([blind])).toContain('1 rule observed nothing: list-admin-users · SQL queries');
        expect(report([blind])).toContain('No input size was exercised');
    });

    test('says explicitly when there is nothing', () => {
        expect(report([held])).toContain('Nothing to report');
    });

    test('shows no tick in front of zero rules held', () => {
        expect(report([lacuna])).not.toContain('0 rule');
    });
});

describe('exitCode', () => {
    test('a violation fails the run', () => {
        expect(exitCode([infraction])).toBe(1);
    });

    test('a gap is a question, not a refusal', () => {
        expect(exitCode([lacuna])).toBe(0);
    });

    test('nothing to report passes', () => {
        expect(exitCode([held])).toBe(0);
    });
});
