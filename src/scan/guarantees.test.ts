import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGuarantees, type Guarantee } from './guarantees';

let directory = '';
let path = '';

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'speccov-tsconfig-'));
    path = join(directory, 'tsconfig.json');
});

afterEach(async () => {
    await unlink(path).catch(() => {});
    await rmdir(directory).catch(() => {});
});

async function write(config: unknown): Promise<void> {
    await writeFile(path, JSON.stringify(config), 'utf8');
}

function flagOf(flags: readonly Guarantee[], flag: string): Guarantee | undefined {
    return flags.find((guarantee) => guarantee.flag === flag);
}

/**
 * The complete truth table under `strict: true`.
 *
 * Written in answer to surviving mutants: without it, you can blank out a flag's name or
 * flip its `impliedByStrict` on 8 entries out of 10 without a single test so much as
 * flinching.
 */
const UNDER_STRICT: readonly (readonly [string, boolean])[] = [
    ['strictNullChecks', true],
    ['noImplicitAny', true],
    ['useUnknownInCatchVariables', true],
    ['strictFunctionTypes', true],
    ['strictPropertyInitialization', true],
    ['noUncheckedIndexedAccess', false],
    ['exactOptionalPropertyTypes', false],
    ['noFallthroughCasesInSwitch', false],
    ['noImplicitOverride', false],
    ['noPropertyAccessFromIndexSignature', false],
];

describe('flag table under strict', () => {
    test('covers exactly the declared flags, none missing, none extra', async () => {
        await write({ compilerOptions: { strict: true } });
        const result = readGuarantees(path);
        if (result.kind !== 'read') {
            throw new Error('expected readable');
        }
        expect(result.flags.map(({ flag }) => flag)).toEqual(UNDER_STRICT.map(([flag]) => flag));
    });

    test.each(UNDER_STRICT)('%s is %s under strict', async (flag, expected) => {
        await write({ compilerOptions: { strict: true } });
        const result = readGuarantees(path);
        if (result.kind !== 'read') {
            throw new Error('expected readable');
        }
        expect(flagOf(result.flags, flag)?.enabled).toBe(expected);
    });

    test('every flag carries a readable, non-empty sentence', async () => {
        await write({ compilerOptions: { strict: true } });
        const result = readGuarantees(path);
        if (result.kind !== 'read') {
            throw new Error('expected readable');
        }
        for (const { flag, proves } of result.flags) {
            expect(proves.trim().length, `sentence missing for ${flag}`).toBeGreaterThan(10);
        }
    });
});

describe('readGuarantees', () => {
    test('strict implies the flags it covers', async () => {
        await write({ compilerOptions: { strict: true } });
        const result = readGuarantees(path);
        if (result.kind !== 'read') {
            throw new Error('expected readable');
        }
        expect(flagOf(result.flags, 'strictNullChecks')?.enabled).toBe(true);
        expect(flagOf(result.flags, 'noImplicitAny')?.enabled).toBe(true);
    });

    test('strict does not imply the ones it does not cover', async () => {
        await write({ compilerOptions: { strict: true } });
        const result = readGuarantees(path);
        if (result.kind !== 'read') {
            throw new Error('expected readable');
        }
        expect(flagOf(result.flags, 'noUncheckedIndexedAccess')?.enabled).toBe(false);
        expect(flagOf(result.flags, 'exactOptionalPropertyTypes')?.enabled).toBe(false);
    });

    test('a flag explicitly set to false wins over strict', async () => {
        await write({ compilerOptions: { strict: true, strictNullChecks: false } });
        const result = readGuarantees(path);
        if (result.kind !== 'read') {
            throw new Error('expected readable');
        }
        expect(flagOf(result.flags, 'strictNullChecks')?.enabled).toBe(false);
    });

    test('a flag turned on alone is recognised without strict', async () => {
        await write({ compilerOptions: { noUncheckedIndexedAccess: true } });
        const result = readGuarantees(path);
        if (result.kind !== 'read') {
            throw new Error('expected readable');
        }
        expect(flagOf(result.flags, 'noUncheckedIndexedAccess')?.enabled).toBe(true);
    });

    test('an unresolved extends concludes nothing rather than alerting wrongly', async () => {
        await write({ extends: '@absent/config/nest.json', compilerOptions: {} });
        const result = readGuarantees(path);
        expect(result.kind).toBe('unresolved');
        if (result.kind !== 'unresolved') {
            throw new Error('expected unresolved');
        }
        expect(result.reason).toContain('not found');
    });

    test('ignores "no inputs were found": that diagnostic is not about the compilerOptions', async () => {
        // A temporary directory holds no .ts: TS18003 is systematic here.
        await write({ compilerOptions: { strict: true } });
        expect(readGuarantees(path).kind).toBe('read');
    });

    test('a missing file concludes nothing either', () => {
        expect(readGuarantees(join(directory, 'nowhere.json')).kind).toBe('unresolved');
    });
});

/**
 * A "solution" tsconfig — `files: []` plus `references` — declares no option at all.
 * Reading it as-is would call everything off on a Nuxt project that is in fact full
 * strict: the same false alarm as the unresolved `extends`, through another door.
 */
describe('solution tsconfig', () => {
    async function reference(name: string, config: unknown): Promise<string> {
        const at = join(directory, name);
        await writeFile(at, JSON.stringify(config), 'utf8');
        return at;
    }

    afterEach(async () => {
        for (const name of ['app.json', 'server.json', 'cycle.json']) {
            await unlink(join(directory, name)).catch(() => {});
        }
    });

    test('descends into the referenced projects rather than concluding emptiness', async () => {
        await reference('app.json', { compilerOptions: { strict: true, noImplicitOverride: true } });
        await write({ files: [], references: [{ path: './app.json' }] });

        const read = readGuarantees(path);

        expect(read.kind).toBe('read');
        if (read.kind !== 'read') {
            return;
        }
        expect(flagOf(read.flags, 'strictNullChecks')?.enabled).toBe(true);
        expect(flagOf(read.flags, 'noImplicitOverride')?.enabled).toBe(true);
    });

    test('a guarantee holds only if it holds in every referenced project', async () => {
        await reference('app.json', { compilerOptions: { strict: true, noImplicitOverride: true } });
        await reference('server.json', { compilerOptions: { strict: true } });
        await write({ files: [], references: [{ path: './app.json' }, { path: './server.json' }] });

        const read = readGuarantees(path);

        expect(read.kind).toBe('read');
        if (read.kind !== 'read') {
            return;
        }
        expect(flagOf(read.flags, 'strictNullChecks')?.enabled).toBe(true);
        expect(flagOf(read.flags, 'noImplicitOverride')?.enabled).toBe(false);
    });

    test('a reference that cannot be found makes the scope unreadable, never lukewarm', async () => {
        await write({ files: [], references: [{ path: './absent.json' }] });

        const read = readGuarantees(path);

        expect(read.kind).toBe('unresolved');
        if (read.kind !== 'unresolved') {
            return;
        }
        expect(read.reason).toContain('absent.json');
    });

    test('a cycle of references does not loop', async () => {
        await reference('cycle.json', { files: [], references: [{ path: './tsconfig.json' }] });
        await write({ files: [], references: [{ path: './cycle.json' }] });

        const read = readGuarantees(path);

        expect(read.kind).toBe('unresolved');
        if (read.kind !== 'unresolved') {
            return;
        }
        // Without this, mutation showed any other refusal passing for a cycle.
        expect(read.reason).toContain('circular');
    });
});

/**
 * The sentences in the table are the tool's own output: they are what a human reads to
 * decide whether to trust it. A mutation blanked them with no test protesting — a mute
 * report would have passed CI.
 */
test('every flag announces what it proves, in a non-empty sentence', async () => {
    await write({ compilerOptions: { strict: true } });

    const read = readGuarantees(path);

    expect(read.kind).toBe('read');
    if (read.kind !== 'read') {
        return;
    }
    expect(read.flags).toHaveLength(10);
    for (const { flag, proves } of read.flags) {
        expect(flag).not.toBe('');
        expect(proves.length).toBeGreaterThan(20);
        expect(proves).not.toContain(flag);
    }
    expect(new Set(read.flags.map(({ proves }) => proves)).size).toBe(10);
});

/**
 * An option value newer than the TypeScript shipped here must neither silence the scope
 * nor vanish: the flags stay read, the option is declared.
 */
describe('unrecognised option value', () => {
    test('does not block the flag read, but declares itself', async () => {
        await write({ compilerOptions: { strict: true, lib: ['es2099'] } });

        const read = readGuarantees(path);

        expect(read.kind).toBe('read');
        if (read.kind !== 'read') {
            return;
        }
        expect(flagOf(read.flags, 'strictNullChecks')?.enabled).toBe(true);
        expect(read.unrecognised).toEqual(['lib']);
    });

    test('a healthy tsconfig declares nothing', async () => {
        await write({ compilerOptions: { strict: true } });

        const read = readGuarantees(path);

        expect(read.kind === 'read' && read.unrecognised).toEqual([]);
    });

    test('a diagnostic of another nature stays blocking', async () => {
        await write({ compilerOptions: { strict: true }, extends: './not-found.json' });

        expect(readGuarantees(path).kind).toBe('unresolved');
    });

    test('an unrecognised option in a referenced project rises to the scope', async () => {
        const at = join(directory, 'app.json');
        await writeFile(at, JSON.stringify({ compilerOptions: { strict: true, target: 'es2099' } }), 'utf8');
        await write({ files: [], references: [{ path: './app.json' }] });

        const read = readGuarantees(path);

        expect(read.kind === 'read' && read.unrecognised).toEqual(['target']);
        await unlink(at).catch(() => {});
    });
});
