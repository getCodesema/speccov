import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accept, applyAnswers, loadAnswers, parseAnswers, saveAnswers, type Answer } from './answers';
import type { Lacuna, Measurement, Rule, Verdict } from './rule';

const measurements: readonly Measurement[] = [
    { size: 1, cost: 1 },
    { size: 2, cost: 2 },
];

function rule(name: string): Rule {
    return {
        name,
        intention: 'The cost does not grow with the input size',
        origin: 'default',
        measure: async () => measurements,
        judge: () => ({ held: false, exercised: true, magnitude: 1, detail: 'does not matter' }),
    };
}

function lacuna(name: string, magnitude: number): Lacuna {
    return {
        kind: 'lacuna',
        rule: rule(name),
        measurements,
        magnitude,
        detail: `grows by ≈ ${magnitude} per item`,
        question: 'Is this intended?',
    };
}

const answered: Answer = { rule: 'a', magnitude: 1, detail: 'grows by ≈ 1 per item', at: '2026-08-22' };

describe('applyAnswers', () => {
    test('keeps an already-accepted gap quiet, but counts it', () => {
        const applied = applyAnswers([lacuna('a', 1)], [answered]);
        expect(applied.verdicts).toHaveLength(0);
        expect(applied.accepted).toHaveLength(1);
    });

    test('keeps an improvement below the threshold quiet too', () => {
        const applied = applyAnswers([lacuna('a', 0.5)], [answered]);
        expect(applied.accepted).toHaveLength(1);
    });

    test('passing the threshold becomes a violation: a human had ruled on it', () => {
        const [verdict] = applyAnswers([lacuna('a', 2)], [answered]).verdicts;
        expect(verdict?.kind).toBe('infraction');
    });

    test('the violation recalls the accepted threshold and date', () => {
        const [verdict] = applyAnswers([lacuna('a', 2)], [answered]).verdicts;
        expect(verdict?.detail).toContain('Accepted on 2026-08-22 at a magnitude of 1');
        expect(verdict?.detail).toContain('the threshold is exceeded');
    });

    test('a gap with no answer stays a question', () => {
        const [verdict] = applyAnswers([lacuna('b', 3)], [answered]).verdicts;
        expect(verdict?.kind).toBe('lacuna');
    });

    test('touches neither the rules held nor the existing violations', () => {
        const held: Verdict = { kind: 'held', rule: rule('a'), measurements, magnitude: 0, detail: 'constant' };
        const infraction: Verdict = { kind: 'infraction', rule: rule('a'), measurements, magnitude: 9, detail: 'broken' };
        expect(applyAnswers([held, infraction], [answered]).verdicts).toEqual([held, infraction]);
    });
});

describe('accept', () => {
    test('freezes the threshold measured today', () => {
        expect(accept(lacuna('a', 2), '2026-08-22')).toEqual({
            rule: 'a',
            magnitude: 2,
            detail: 'grows by ≈ 2 per item',
            at: '2026-08-22',
        });
    });

    test('keeps the reason, trimmed', () => {
        expect(accept(lacuna('a', 2), '2026-08-22', '  tracked in #4  ').why).toBe('tracked in #4');
    });

    test('omits an empty reason rather than storing whitespace', () => {
        expect(accept(lacuna('a', 2), '2026-08-22', '   ')).not.toHaveProperty('why');
    });
});

describe('parseAnswers', () => {
    test('accepts a conforming file', () => {
        expect(parseAnswers({ version: 1, answers: [answered] }, 'f.json')).toEqual([answered]);
    });

    test('refuses an unknown version', () => {
        expect(() => parseAnswers({ version: 2, answers: [] }, 'f.json')).toThrow('is not a valid answers file');
    });

    test('refuses an unreadable entry rather than skipping it', () => {
        expect(() => parseAnswers({ version: 1, answers: [{ rule: 'a' }] }, 'f.json')).toThrow('answer 0 is unreadable');
    });

    test('refuses a non-finite magnitude', () => {
        expect(() => parseAnswers({ version: 1, answers: [{ ...answered, magnitude: Number.NaN }] }, 'f.json')).toThrow(
            'answer 0 is unreadable',
        );
    });
});

async function ignoreMissing(work: Promise<unknown>): Promise<void> {
    try {
        await work;
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw cause;
        }
    }
}

describe('on disk', () => {
    let directory = '';
    let path = '';

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'speccov-'));
        path = join(directory, 'nested', 'answers.json');
    });

    afterEach(async () => {
        // Explicit cleanup, no recursive delete: we know exactly what we created.
        await ignoreMissing(unlink(path));
        await ignoreMissing(rmdir(join(directory, 'nested')));
        await ignoreMissing(rmdir(directory));
    });

    test('a missing file is a first pass, not an error', async () => {
        expect(await loadAnswers(path)).toEqual([]);
    });

    test('creates the directory and round-trips faithfully', async () => {
        await saveAnswers(path, [answered]);
        expect(await loadAnswers(path)).toEqual([answered]);
    });

    test('sorts by rule so the diff stays readable in review', async () => {
        await saveAnswers(path, [
            { ...answered, rule: 'z' },
            { ...answered, rule: 'a' },
        ]);
        expect((await loadAnswers(path)).map((answer) => answer.rule)).toEqual(['a', 'z']);
    });

    test('a corrupted file throws: neither all accepted nor all forgotten', async () => {
        await saveAnswers(path, []);
        await writeFile(path, '{ not json', 'utf8');
        expect(loadAnswers(path)).rejects.toThrow();
    });
});
