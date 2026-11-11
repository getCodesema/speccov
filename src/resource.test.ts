import { describe, expect, test } from 'bun:test';
import { Gauge } from './gauge';
import { resource } from './resource';

describe('resource', () => {
    test('bounded work holds the rule', async () => {
        const gauge = new Gauge();
        const rule = resource({
            name: 'sequential',
            ceiling: 5,
            gauge,
            subject: async (size) => {
                for (let index = 0; index < size; index += 1) {
                    await gauge.track(() => Promise.resolve());
                }
            },
        });
        const judgement = rule.judge(await rule.measure());
        expect(judgement.held).toBe(true);
        expect(judgement.magnitude).toBe(0);
    });

    test('an unbounded Promise.all crosses the ceiling', async () => {
        const gauge = new Gauge();
        const rule = resource({
            name: 'unbounded Promise.all',
            unit: 'concurrent queries',
            ceiling: 5,
            gauge,
            subject: async (size) => {
                await Promise.all(Array.from({ length: size }, () => gauge.track(() => Promise.resolve())));
            },
        });
        const judgement = rule.judge(await rule.measure());
        expect(judgement.held).toBe(false);
        // Peak of 16 on the largest size, against a ceiling of 5.
        expect(judgement.magnitude).toBe(11);
        expect(judgement.detail).toContain('Peak of 16 concurrent queries against a ceiling of 5');
    });

    test('carries its own sentence, ceiling included', () => {
        const rule = resource({ name: 'x', ceiling: 5, gauge: new Gauge(), subject: () => {} });
        expect(rule.intention).toBe('Peak concurrent operations never exceeds 5');
    });

    test('choosing a ceiling is writing a rule: the origin is declared', () => {
        expect(resource({ name: 'x', ceiling: 5, gauge: new Gauge(), subject: () => {} }).origin).toBe('declared');
    });

    test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses an invalid ceiling: %s', (ceiling) => {
        expect(() => resource({ name: 'x', ceiling, gauge: new Gauge(), subject: () => {} })).toThrow('invalid ceiling');
    });

    test('refuses to judge with no measurement', () => {
        const rule = resource({ name: 'x', ceiling: 5, gauge: new Gauge(), subject: () => {} });
        expect(() => rule.judge([])).toThrow('no measurement');
    });
});
