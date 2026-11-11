import { describe, expect, test } from 'bun:test';
import { complexity } from './complexity';
import { Counter } from './counter';

describe('complexity', () => {
    test('resets the counter between two sizes', async () => {
        const counter = new Counter();
        const rule = complexity({
            name: 'constant subject',
            unit: 'SQL queries',
            sizes: [1, 2, 4],
            counter,
            subject: () => {
                counter.hit();
                counter.hit();
            },
        });
        expect(await rule.measure()).toEqual([
            { size: 1, cost: 2 },
            { size: 2, cost: 2 },
            { size: 4, cost: 2 },
        ]);
    });

    test('a constant cost holds the rule', async () => {
        const counter = new Counter();
        const rule = complexity({ name: 'constant', counter, subject: () => counter.hit() });
        expect(rule.judge(await rule.measure()).held).toBe(true);
    });

    test('an N+1 does not hold the rule, and the sentence says by how much', async () => {
        const counter = new Counter();
        const rule = complexity({
            name: 'list-members · SQL queries',
            unit: 'SQL queries',
            counter,
            subject: (size) => {
                counter.hit();
                for (let index = 0; index < size; index += 1) {
                    counter.hit();
                }
            },
        });
        const judgement = rule.judge(await rule.measure());
        expect(judgement.held).toBe(false);
        expect(judgement.detail).toContain('grows by ≈ 1 per item');
        expect(judgement.detail).toContain('1→2, 2→3, 4→5, 8→9, 16→17');
    });

    test('the tolerance lets an accepted growth through', async () => {
        const counter = new Counter();
        const rule = complexity({
            name: 'tolerated',
            perItemTolerance: 1,
            counter,
            subject: (size) => {
                for (let index = 0; index < size; index += 1) {
                    counter.hit();
                }
            },
        });
        expect(rule.judge(await rule.measure()).held).toBe(true);
    });

    test('accepts an asynchronous subject', async () => {
        const counter = new Counter();
        const rule = complexity({
            name: 'async',
            sizes: [1, 2],
            counter,
            subject: async () => {
                await Promise.resolve();
                counter.hit();
            },
        });
        expect(await rule.measure()).toEqual([
            { size: 1, cost: 1 },
            { size: 2, cost: 1 },
        ]);
    });

    test('is a default rule, not a written one', () => {
        const counter = new Counter();
        expect(complexity({ name: 'x', counter, subject: () => {} }).origin).toBe('default');
    });

    test('carries its own sentence when none is given', () => {
        const counter = new Counter();
        const rule = complexity({ name: 'x', unit: 'SQL queries', counter, subject: () => {} });
        expect(rule.intention).toBe('The number of SQL queries does not grow with the input size');
    });

    test('refuses an empty intention', () => {
        const counter = new Counter();
        expect(() => complexity({ name: 'silent', intention: '   ', counter, subject: () => {} })).toThrow('has no intention');
    });
});
