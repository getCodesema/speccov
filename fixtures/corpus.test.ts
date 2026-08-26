import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { scan } from '../src/scan/index';
import { compare, readMarkers } from './expectations';

/**
 * The scan, judged against a corpus that says in advance what is there.
 *
 * The unit tests exercise one shape at a time on a snippet held in memory. This one runs the
 * whole pass on a directory: the walk, the tsconfig discovery, the per-scope program, the
 * deduplication. What it adds is the negatives, the lines that must stay silent, because a
 * widened heuristic shows up there first and nowhere in a suite of positive snippets.
 */
const CORPUS = join(import.meta.dir, 'corpus');

test('the scan finds what the corpus declares, and nothing else', async () => {
    const markers = await readMarkers(CORPUS);
    const { sites } = await scan({ root: CORPUS });
    const verdict = compare(markers, sites);

    expect(verdict.missed).toEqual([]);
    expect(verdict.unexpected).toEqual([]);
});

test('the corpus keeps covering both sides: shapes claimed, and lines claimed empty', async () => {
    const markers = await readMarkers(CORPUS);
    const { sites } = await scan({ root: CORPUS });
    const verdict = compare(markers, sites);

    // A corpus that lost its negatives still passes while proving much less. Counted, so that
    // deleting one is a decision rather than an accident.
    expect(verdict.matched).toBeGreaterThanOrEqual(14);
    expect(verdict.negatives).toBeGreaterThanOrEqual(10);
});

test('a package with its own tsconfig is a second scope, read like the first', async () => {
    const result = await scan({ root: CORPUS });

    expect(result.refused).toEqual([]);
    expect(result.guarantees.map(({ path }) => path)).toEqual(['tsconfig.json', 'packages/reporting/tsconfig.json']);
    // Addressed from the root the scan was given, not from the package it belongs to.
    expect(result.sites.some(({ file }) => file === 'packages/reporting/src/exports.ts')).toBe(true);
});

/**
 * What was not read is counted, never silenced. The figures below are the corpus as it stands:
 * adding a file to it means updating them, which is the point. A count that adjusts itself
 * would agree with any walk, including a broken one.
 */
test('the accounting states what the walk set aside', async () => {
    const result = await scan({ root: CORPUS });

    expect(result.filesScanned).toBe(5);
    expect(result.testsExcluded).toBe(1);
    expect(result.skipped.get('vue')).toBe(1);
});

test('nothing is read out of a build directory, a test file, or a declaration', async () => {
    const { sites } = await scan({ root: CORPUS });
    const files = new Set(sites.map(({ file }) => file));

    // Each of the three carries a real fan-out, and each is set aside for its own reason.
    expect([...files].filter((file) => file.startsWith('dist/'))).toEqual([]);
    expect([...files].filter((file) => file.includes('e2e-spec'))).toEqual([]);
    expect([...files].filter((file) => file.endsWith('.d.ts'))).toEqual([]);
});
