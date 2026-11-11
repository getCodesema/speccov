import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from './index';
import { parseIgnore } from './speccovignore';

const FANOUT =
    'declare function load(x: string): Promise<void>;\nexport async function go(xs: string[]): Promise<void> {\n    await Promise.all(xs.map((x) => load(x)));\n}\n';

/** Two directories carrying the same site: production code, and a harness. */
async function project(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'speccov-ignore-'));
    await writeFile(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', noEmit: true }, include: ['src', 'tools'] }),
        'utf8',
    );
    for (const directory of ['src', 'tools']) {
        await mkdir(join(root, directory));
        await writeFile(join(root, directory, 'service.ts'), FANOUT, 'utf8');
    }
    return root;
}

test('scan leaves out the sites of what the project set aside, and counts them', async () => {
    const root = await project();
    const everything = await scan({ root });
    await writeFile(join(root, '.speccovignore'), '# not where a value enters\ntools/\n', 'utf8');

    const result = await scan({ root });

    expect(everything.ignored).toEqual({ files: 0, sites: 0 });
    expect(new Set(result.sites.map(({ file }) => file))).toEqual(new Set(['src/service.ts']));
    expect(result.ignored).toEqual({ files: 1, sites: everything.sites.length - result.sites.length });
    expect(result.ignored.sites).toBeGreaterThan(0);
    expect(result.filesScanned).toBe(1);
});

test('the same line holds when the scan aims at a directory under the file', async () => {
    const root = await project();
    await writeFile(join(root, '.speccovignore'), 'tools/\n', 'utf8');

    const result = await scan({ root: join(root, 'tools') });

    expect(result.sites).toEqual([]);
    expect(result.ignored.sites).toBeGreaterThan(0);
});

test('a directory named without a slash is set aside at any depth, with everything under it', () => {
    const ignored = parseIgnore('journeys/\n');

    expect(ignored('tools/journeys/login.actions.ts')).toBe(true);
    expect(ignored('journeys/a.ts')).toBe(true);
    expect(ignored('apps/api/src/journeys.ts')).toBe(false);
});

test('a path with a slash is anchored where the file sits', () => {
    const ignored = parseIgnore('tools/journeys\n/apps/player\n');

    expect(ignored('tools/journeys/a.ts')).toBe(true);
    expect(ignored('apps/player/src/b.ts')).toBe(true);
    expect(ignored('packages/tools/journeys/a.ts')).toBe(false);
});

test('a star stays inside one segment, two stars cross them', () => {
    const ignored = parseIgnore('*.actions.ts\napps/*/src/generated/**\n');

    expect(ignored('tools/journeys/login.actions.ts')).toBe(true);
    expect(ignored('apps/api/src/generated/deep/client.ts')).toBe(true);
    expect(ignored('apps/api/src/handwritten/client.ts')).toBe(false);
    expect(ignored('apps/api/nested/src/generated/client.ts')).toBe(false);
});

test('comments and blank lines set nothing aside', () => {
    const ignored = parseIgnore('# the harness\n\n   \n');

    expect(ignored('tools/journeys/a.ts')).toBe(false);
});

test('a dot in a pattern is a dot, not any character', () => {
    expect(parseIgnore('a.ts')('axts')).toBe(false);
});

test('a negation is refused rather than read as a pattern', () => {
    expect(() => parseIgnore('tools/\n!tools/keep.ts\n')).toThrow('does not support negation');
});
