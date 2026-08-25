import { describe, expect, test } from 'bun:test';
import { isBroken, requireIntention, type Rule, type Verdict } from './rule';

const rule = {
    name: 'subject',
    intention: 'does not matter',
    origin: 'declared',
    measure: async () => [],
    judge: () => ({ held: true, exercised: true, magnitude: 0, detail: 'does not matter' }),
} satisfies Rule;

const shell = { rule, measurements: [], magnitude: 0, detail: 'does not matter' } as const;

describe('isBroken', () => {
    const cases: readonly [Verdict['kind'], Verdict, boolean][] = [
        ['infraction', { ...shell, kind: 'infraction' }, true],
        ['lacuna', { ...shell, kind: 'lacuna', question: 'why?' }, true],
        ['held', { ...shell, kind: 'held' }, false],
        // A rule never exercised is not violated: nothing says the code is at fault.
        ['vacuous', { ...shell, kind: 'vacuous', question: 'why?' }, false],
    ];

    for (const [kind, verdict, expected] of cases) {
        test(`${kind} → ${expected}`, () => {
            expect(isBroken(verdict)).toBe(expected);
        });
    }
});

describe('requireIntention', () => {
    test('returns the sentence, trimmed', () => {
        expect(requireIntention('subject', '  The cost stays constant  ')).toBe('The cost stays constant');
    });

    for (const [label, value] of [
        ['missing', undefined],
        ['empty', ''],
        ['blank', '   '],
    ] as const) {
        test(`refuses a ${label} intention`, () => {
            expect(() => requireIntention('subject', value)).toThrow('subject');
        });
    }
});
