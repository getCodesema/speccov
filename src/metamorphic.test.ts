import { describe, expect, test } from 'bun:test';
import { metamorphic } from './metamorphic';

/** The successive pages of a list: `total` must be the same everywhere. */
const pages = [
    { limit: 10, offset: 0 },
    { limit: 10, offset: 10 },
    { limit: 10, offset: 20 },
];

describe('metamorphic', () => {
    test('an invariant observation holds the rule', async () => {
        const rule = metamorphic({
            name: 'list-members · total',
            intention: 'The announced total does not depend on the page requested',
            variants: pages,
            observe: () => 42,
        });
        const judgement = rule.judge(await rule.measure());
        expect(judgement.held).toBe(true);
        expect(judgement.detail).toBe('Same observation across 3 variants');
    });

    test('a total that follows the page does not hold the rule', async () => {
        const rule = metamorphic({
            name: 'list-members · total',
            intention: 'The announced total does not depend on the page requested',
            variants: pages,
            // The real defect: `total: items.length` after filtering.
            observe: ({ offset }) => (offset === 20 ? 2 : 10),
        });
        const judgement = rule.judge(await rule.measure());
        expect(judgement.held).toBe(false);
        expect(judgement.magnitude).toBe(1);
        expect(judgement.detail).toContain('2 different values across 3 variants');
    });

    test('shows each variant and its value to make the defect obvious', async () => {
        const rule = metamorphic({
            name: 'x',
            intention: 'Invariant',
            variants: [1, 2],
            observe: (variant) => variant * 10,
            describe: (variant) => `page ${variant}`,
        });
        expect(rule.judge(await rule.measure()).detail).toContain('page 1 → 10 ; page 2 → 20');
    });

    test('accepts an asynchronous observation', async () => {
        const rule = metamorphic({
            name: 'x',
            intention: 'Invariant',
            variants: [1, 2],
            observe: async (variant) => Promise.resolve(variant),
        });
        expect(rule.judge(await rule.measure()).held).toBe(false);
    });

    test('compares structured values, not only scalars', async () => {
        const rule = metamorphic({
            name: 'x',
            intention: 'Invariant',
            variants: [1, 2],
            observe: () => ({ total: 42, kind: 'page' }),
        });
        expect(rule.judge(await rule.measure()).held).toBe(true);
    });

    test('a single variant throws: comparing a thing to nothing proves nothing', () => {
        expect(() => metamorphic({ name: 'x', intention: 'y', variants: [1], observe: () => 1 })).toThrow(
            'needs at least two variants',
        );
    });

    test('refuses an empty intention', () => {
        expect(() => metamorphic({ name: 'silent', intention: ' ', variants: [1, 2], observe: () => 1 })).toThrow(
            'has no intention',
        );
    });
});
