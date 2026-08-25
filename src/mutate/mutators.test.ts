import { describe, expect, test } from 'bun:test';
import { applyMutant, findMutants, type Mutant } from './mutators';

function mutate(source: string): readonly string[] {
    return findMutants('x.ts', source).map((mutant) => applyMutant(source, mutant));
}

function mutators(source: string): readonly string[] {
    return [...new Set(findMutants('x.ts', source).map(({ mutator }) => mutator))];
}

describe('findMutants', () => {
    test.each([
        ['a > b', 'a >= b'],
        ['a >= b', 'a > b'],
        ['a < b', 'a <= b'],
        ['a <= b', 'a < b'],
    ])('moves the bound from %s to %s', (source, expected) => {
        expect(mutate(source)).toContain(expected);
    });

    test.each([
        ['a === b', 'a !== b'],
        ['a !== b', 'a === b'],
    ])('flips the equality from %s to %s', (source, expected) => {
        expect(mutate(source)).toContain(expected);
    });

    test.each([
        ['a && b', 'a || b'],
        ['a || b', 'a && b'],
        ['a ?? b', 'a || b'],
    ])('swaps the logical operator from %s to %s', (source, expected) => {
        expect(mutate(source)).toContain(expected);
    });

    test.each([
        ['a + b', 'a - b'],
        ['a - b', 'a + b'],
        ['a * b', 'a / b'],
        ['a / b', 'a * b'],
    ])('swaps the arithmetic operator from %s to %s', (source, expected) => {
        expect(mutate(source)).toContain(expected);
    });

    test('flips booleans', () => {
        expect(mutate('const a = true;')).toContain('const a = false;');
        expect(mutate('const a = false;')).toContain('const a = true;');
    });

    test('removes a negation', () => {
        expect(mutate('if (!ready) go();')).toContain('if (ready) go();');
    });

    test('empties a non-empty array', () => {
        expect(mutate('const xs = [1, 2, 3];')).toContain('const xs = [];');
    });

    test('does not empty an already empty array', () => {
        expect(mutators('const xs = [];')).not.toContain('array emptied');
    });

    test('empties a non-empty string', () => {
        expect(mutate('const s = "abc";')).toContain('const s = "";');
    });

    test('removes an optional chain', () => {
        expect(mutate('const v = user?.name;')).toContain('const v = user.name;');
    });

    test('empties a function body', () => {
        expect(mutate('function go() { doSomething(); }')).toContain('function go() {}');
    });

    test('does not empty an already empty body', () => {
        expect(mutators('function go() {}')).not.toContain('body emptied');
    });

    test('gives the mutant its line', () => {
        const [mutant] = findMutants('a.ts', '\n\nconst a = true;');
        expect(mutant?.line).toBe(3);
    });

    test('the identifier is stable from one run to the next', () => {
        const source = 'const a = true;';
        expect(findMutants('a.ts', source)[0]?.id).toBe(findMutants('a.ts', source)[0]?.id ?? '');
    });

    test('different mutants get different identifiers', () => {
        const ids = findMutants('a.ts', 'const a = true;\nconst b = false;').map(({ id }) => id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('a file with no mutable shape produces nothing', () => {
        expect(findMutants('a.ts', 'export type A = { b: number };')).toEqual([]);
    });
});

describe('applyMutant', () => {
    test('replaces only the targeted slice', () => {
        const source = 'if (a > b) { go(); }';
        const mutant = findMutants('x.ts', source).find(({ mutator }) => mutator === 'comparison');
        expect(applyMutant(source, mutant as Mutant)).toBe('if (a >= b) { go(); }');
    });

    test('does not touch the original source', () => {
        const source = 'const a = true;';
        const [mutant] = findMutants('x.ts', source);
        applyMutant(source, mutant as Mutant);
        expect(source).toBe('const a = true;');
    });
});

test('nodes erased at compile time carry no mutant', () => {
    const mutants = findMutants(
        'types.ts',
        `type Kind = { kind: 'read' } | { kind: 'unresolved' };
interface Port { readonly name: 'fixed' }
import type { Far } from './far';
const live = 'alive';`,
    );

    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.original).toBe("'alive'");
});
