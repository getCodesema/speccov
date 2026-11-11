import { describe, expect, test } from 'bun:test';
import { measureGrowth } from './growth';

describe('measureGrowth', () => {
    test('a constant cost does not grow', () => {
        const growth = measureGrowth([
            { size: 1, cost: 3 },
            { size: 2, cost: 3 },
            { size: 4, cost: 3 },
        ]);
        expect(growth.perItem).toBe(0);
    });

    test('an N+1 grows by one operation per item', () => {
        const growth = measureGrowth([
            { size: 1, cost: 3 },
            { size: 2, cost: 4 },
            { size: 4, cost: 6 },
            { size: 8, cost: 10 },
            { size: 16, cost: 18 },
        ]);
        // Least squares over integers: the exact slope is 1 but the float returns 0.9999…
        expect(growth.perItem).toBeCloseTo(1, 10);
    });

    test('two queries per item read straight off the slope', () => {
        const growth = measureGrowth([
            { size: 2, cost: 4 },
            { size: 4, cost: 8 },
            { size: 6, cost: 12 },
        ]);
        expect(growth.perItem).toBe(2);
    });

    test('a single noisy measurement does not tip a constant cost over', () => {
        const growth = measureGrowth([
            { size: 1, cost: 5 },
            { size: 2, cost: 5 },
            { size: 4, cost: 6 },
            { size: 8, cost: 5 },
            { size: 16, cost: 5 },
        ]);
        expect(Math.abs(growth.perItem)).toBeLessThan(0.05);
    });

    test('the series is ready to display', () => {
        const growth = measureGrowth([
            { size: 1, cost: 3 },
            { size: 2, cost: 4 },
        ]);
        expect(growth.series).toBe('1→3, 2→4');
    });

    describe('refuses to conclude on unusable data', () => {
        test('a single measurement', () => {
            expect(() => measureGrowth([{ size: 1, cost: 3 }])).toThrow('at least two measurements');
        });

        test('no measurement', () => {
            expect(() => measureGrowth([])).toThrow('at least two measurements');
        });

        test('sizes that are all identical', () => {
            expect(() =>
                measureGrowth([
                    { size: 4, cost: 3 },
                    { size: 4, cost: 9 },
                ]),
            ).toThrow('undecidable');
        });

        test('a zero or negative size', () => {
            expect(() =>
                measureGrowth([
                    { size: 0, cost: 3 },
                    { size: 2, cost: 4 },
                ]),
            ).toThrow('invalid input size');
        });

        test('a negative cost', () => {
            expect(() =>
                measureGrowth([
                    { size: 1, cost: -1 },
                    { size: 2, cost: 4 },
                ]),
            ).toThrow('invalid cost');
        });

        test('a non-finite value', () => {
            expect(() =>
                measureGrowth([
                    { size: 1, cost: Number.NaN },
                    { size: 2, cost: 4 },
                ]),
            ).toThrow('invalid cost');
        });
    });
});
