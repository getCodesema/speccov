import { describe, expect, test } from 'bun:test';
import { forbidden } from './forbidden';

const roles = ['viewer', 'org_admin', 'platform_admin'] as const;

describe('forbidden', () => {
    test('no counterexample holds the rule', async () => {
        const rule = forbidden({
            name: 'no access outside the area',
            intention: 'An actor scoped to one area never sees a user outside their area',
            cases: roles,
            forbids: () => false,
        });
        const judgement = rule.judge(await rule.measure());
        expect(judgement.held).toBe(true);
        expect(judgement.detail).toBe('No counterexample across 3 input(s) tried');
    });

    test('counts the counterexamples and names the first', async () => {
        const rule = forbidden({
            name: 'no access outside the area',
            intention: 'No non-platform role may get global access',
            cases: roles,
            forbids: (role) => role !== 'platform_admin',
        });
        const judgement = rule.judge(await rule.measure());
        expect(judgement.held).toBe(false);
        expect(judgement.magnitude).toBe(2);
        expect(judgement.detail).toContain('2 counterexample(s) across 3 input(s), including "viewer"');
    });

    test('accepts a case-generating function', async () => {
        const rule = forbidden({
            name: 'x',
            intention: 'Nothing may pass',
            cases: () => [1, 2, 3],
            forbids: (value) => value === 2,
        });
        expect(rule.judge(await rule.measure()).magnitude).toBe(1);
    });

    test('accepts an asynchronous predicate', async () => {
        const rule = forbidden({
            name: 'x',
            intention: 'Nothing may pass',
            cases: [1, 2],
            forbids: async (value) => Promise.resolve(value === 1),
        });
        expect(rule.judge(await rule.measure()).magnitude).toBe(1);
    });

    test('a custom describe makes the counterexample readable', async () => {
        const rule = forbidden({
            name: 'x',
            intention: 'Nothing may pass',
            cases: [{ role: 'viewer', areaId: null }],
            forbids: () => true,
            describe: (value) => `role ${value.role} with no area`,
        });
        expect(rule.judge(await rule.measure()).detail).toContain('role viewer with no area');
    });

    test('zero case tried throws: a ban without cases proves nothing', async () => {
        const rule = forbidden({ name: 'empty', intention: 'Nothing may pass', cases: [], forbids: () => true });
        expect(rule.measure()).rejects.toThrow('tried no input');
    });

    test('a ban is domain knowledge: the origin is declared', () => {
        expect(forbidden({ name: 'x', intention: 'y', cases: [1], forbids: () => false }).origin).toBe('declared');
    });

    test('refuses an empty intention', () => {
        expect(() => forbidden({ name: 'silent', intention: '  ', cases: [1], forbids: () => false })).toThrow(
            'has no intention',
        );
    });
});
