import { describe, expect, test } from 'bun:test';
import { allOf } from './domain';

type Actor = {
    readonly role: 'viewer' | 'org_admin' | 'platform_viewer' | 'platform_admin';
    readonly areaId: string | null;
};

const ACTORS: Parameters<typeof allOf<Actor>>[0] = {
    role: ['viewer', 'org_admin', 'platform_viewer', 'platform_admin'],
    areaId: ['area-north', null],
};

describe('allOf', () => {
    test('builds every combination, not a sample', () => {
        expect(allOf<Actor>(ACTORS)).toHaveLength(8);
    });

    test('the first case is the simplest: the first value of every field', () => {
        expect(allOf<Actor>(ACTORS)[0]).toEqual({ role: 'viewer', areaId: 'area-north' });
    });

    test('a case deviating on one field comes before a case deviating on two', () => {
        const built = allOf<Actor>(ACTORS);
        const oneOff = built.findIndex((actor) => actor.role === 'org_admin' && actor.areaId === 'area-north');
        const twoOff = built.findIndex((actor) => actor.role === 'org_admin' && actor.areaId === null);
        expect(oneOff).toBeLessThan(twoOff);
    });

    test('the scope defect is in the batch without anyone having written it', () => {
        expect(allOf<Actor>(ACTORS)).toContainEqual({ role: 'org_admin', areaId: null });
    });

    test('a field with no value is a refusal, not an empty domain', () => {
        expect(() => allOf<{ role: string }>({ role: [] })).toThrow(/no value for/u);
    });

    test('a domain with no field is a refusal', () => {
        expect(() => allOf({})).toThrow(/no field/u);
    });

    test('an absurd domain is refused, never sampled in silence', () => {
        const wide = Object.fromEntries(
            Array.from({ length: 8 }, (_unused, index) => [`f${index}`, Array.from({ length: 20 }, (_u, i) => i)]),
        );
        expect(() => allOf(wide as Record<string, readonly number[]>)).toThrow(/typo, not a domain/u);
    });
});
