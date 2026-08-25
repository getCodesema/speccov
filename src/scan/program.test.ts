import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { analyseScope } from './program';

/**
 * The scope named by a **relative** path.
 *
 * `ts.sys.readDirectory` does not resolve a relative `basePath` against the current
 * directory: it yields zero files and the only diagnostic is TS18003, which the flag read
 * ignores on purpose. The scope therefore came out "refused: no input file in this scope" —
 * and a `speccov scan ../other-repo` refused all nineteen scopes of a real-world monorepo,
 * returning a green report without having read a line.
 */
let directory = '';

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'speccov-scope-'));
    await writeFile(
        join(directory, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', noEmit: true } }),
        'utf8',
    );
    await writeFile(
        join(directory, 'fanout.ts'),
        'declare function load(x: string): Promise<void>;\nexport async function go(xs: string[]): Promise<void> {\n    await Promise.all(xs.map((x) => load(x)));\n}\n',
        'utf8',
    );
});

afterEach(async () => {
    await unlink(join(directory, 'tsconfig.json')).catch(() => {});
    await unlink(join(directory, 'fanout.ts')).catch(() => {});
    await unlink(join(directory, 'fanout.rules.ts')).catch(() => {});
    await rmdir(directory).catch(() => {});
});

test('a tsconfig named by a relative path is analysed, not refused', () => {
    const root = relative(process.cwd(), directory);
    expect(root.startsWith('..')).toBe(true);

    const analysis = analyseScope(root, join(root, 'tsconfig.json'));

    expect(analysis.kind).toBe('analysed');
    if (analysis.kind !== 'analysed') {
        return;
    }
    expect(analysis.filesTyped).toBe(1);
    expect(analysis.sites.map((site) => site.kind)).toContain('unbounded-fanout');
});

test('the same scope in absolute form gives exactly the same sites', () => {
    const viaRelative = analyseScope(
        relative(process.cwd(), directory),
        join(relative(process.cwd(), directory), 'tsconfig.json'),
    );
    const viaAbsolute = analyseScope(directory, join(directory, 'tsconfig.json'));

    expect(viaRelative).toEqual(viaAbsolute);
});

/**
 * The drafts speccov writes carry the answer, not the question.
 *
 * A `.rules.ts` doubles the repo to measure the site, and its doubles look like the code
 * they replace — `{ items, total }` up front. Re-read by `scan`, it came back out as a
 * candidate: on a real-world monorepo, `list-admin-users.rules.ts:84` flagged its own fixture.
 */
test('a .rules.ts is set aside: scan does not re-read itself', async () => {
    await writeFile(
        join(directory, 'fanout.rules.ts'),
        'declare const xs: string[];\nexport const page = { items: xs, total: xs.length };\n',
        'utf8',
    );

    const analysis = analyseScope(directory, join(directory, 'tsconfig.json'));

    expect(analysis.kind).toBe('analysed');
    if (analysis.kind !== 'analysed') {
        return;
    }
    expect(analysis.filesTyped).toBe(1);
    expect(analysis.sites.map((site) => site.kind)).not.toContain('paginated-return');
});
