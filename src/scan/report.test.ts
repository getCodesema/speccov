import { describe, expect, test } from 'bun:test';
import type { Guarantee } from './guarantees';
import { reportScan, type ScanResult } from './report';

const FLAG: Guarantee = { flag: 'strictNullChecks', proves: 'no value is implicitly nullable', enabled: true };

function result(overrides: Partial<ScanResult> = {}): ScanResult {
    return {
        guarantees: [{ path: 'apps/api/tsconfig.json', guarantees: { kind: 'read', flags: [FLAG], unrecognised: [] } }],
        sites: [],
        filesScanned: 10,
        unreadable: [],
        skipped: new Map(),
        testsExcluded: 0,
        ignored: { files: 0, sites: 0 },
        refused: [],
        ...overrides,
    };
}

describe('reportScan', () => {
    test('the four zones are always present', () => {
        const rendered = reportScan(result());
        expect(rendered).toContain('Proven by construction');
        expect(rendered).toContain('Guaranteed by nobody');
        expect(rendered).toContain('Not measured');
        expect(rendered).toContain('nothing executed');
    });

    test('an active flag is carried as a construction guarantee', () => {
        expect(reportScan(result())).toContain('✓ no value is implicitly nullable  (strictNullChecks)');
    });

    test('gets the plural of bounded fan-outs right', () => {
        const site = { kind: 'bounded-fanout', file: 'a.ts', line: 1, excerpt: 'x' } as const;
        expect(reportScan(result({ sites: [site, site] }))).toContain('2 fan-outs bounded in writing');
    });

    test('a fixed-arity Promise.all is a guarantee, not a risk', () => {
        const rendered = reportScan(
            result({ sites: [{ kind: 'bounded-fanout', file: 'a.ts', line: 1, excerpt: 'Promise.all([a, b])' }] }),
        );
        expect(rendered).toContain('1 fan-out bounded in writing');
    });

    test('an unbounded site becomes a named rule candidate', () => {
        const rendered = reportScan(
            result({ sites: [{ kind: 'unbounded-fanout', file: 'a.ts', line: 7, excerpt: 'Promise.all(xs.map(f))' }] }),
        );
        expect(rendered).toContain('resource()');
        expect(rendered).toContain('a.ts:7');
    });

    test('declares the unparsed files rather than skipping them in silence', () => {
        const rendered = reportScan(result({ skipped: new Map([['vue', 188]]) }));
        expect(rendered).toContain('188 .vue file(s) not read');
    });

    test('declares the deliberately excluded tests too', () => {
        expect(reportScan(result({ testsExcluded: 412 }))).toContain('412 test file(s) deliberately excluded');
    });

    test('declares what the project set aside, sites included', () => {
        expect(reportScan(result({ ignored: { files: 42, sites: 334 } }))).toContain(
            '42 file(s) set aside by .speccovignore, 334 site(s) with them.',
        );
    });

    test('concludes nothing when a tsconfig could not be resolved', () => {
        const rendered = reportScan(
            result({
                guarantees: [{ path: 'ts.json', guarantees: { kind: 'unresolved', path: 'ts.json', reason: 'not found' } }],
            }),
        );
        expect(rendered).toContain('1 unresolved tsconfig(s): ts.json (not found)');
        expect(rendered).toContain('would produce false alarms');
    });

    test('says when no tsconfig was found', () => {
        expect(reportScan(result({ guarantees: [] }))).toContain('No tsconfig found');
    });

    test('a flag active everywhere is a guarantee, with the number of scopes', () => {
        const rendered = reportScan(
            result({
                guarantees: [
                    { path: 'a/tsconfig.json', guarantees: { kind: 'read', flags: [FLAG], unrecognised: [] } },
                    { path: 'b/tsconfig.json', guarantees: { kind: 'read', flags: [FLAG], unrecognised: [] } },
                ],
            }),
        );
        expect(rendered).toContain('✓ no value is implicitly nullable  (strictNullChecks, 2 scopes evaluated)');
    });

    test('a flag active only elsewhere names the scopes that lack it', () => {
        const rendered = reportScan(
            result({
                guarantees: [
                    { path: 'a/tsconfig.json', guarantees: { kind: 'read', flags: [FLAG], unrecognised: [] } },
                    {
                        path: 'b/tsconfig.json',
                        guarantees: { kind: 'read', flags: [{ ...FLAG, enabled: false }], unrecognised: [] },
                    },
                ],
            }),
        );
        expect(rendered).toContain('strictNullChecks is off in b/tsconfig.json');
    });

    test('announces the reach when some scopes could not be read', () => {
        const rendered = reportScan(
            result({
                guarantees: [
                    {
                        path: 'a/tsconfig.json',
                        guarantees: { kind: 'read', flags: [{ ...FLAG, enabled: false }], unrecognised: [] },
                    },
                    { path: 'b/tsconfig.json', guarantees: { kind: 'unresolved', path: 'b', reason: 'not found' } },
                ],
            }),
        );
        expect(rendered).toContain('reach: 1 of 2 scope(s)');
    });

    test('a flag that is off never claims to hold "everywhere"', () => {
        const rendered = reportScan(
            result({
                guarantees: [
                    {
                        path: 'a/tsconfig.json',
                        guarantees: { kind: 'read', flags: [{ ...FLAG, enabled: false }], unrecognised: [] },
                    },
                ],
            }),
        );
        expect(rendered).toContain('strictNullChecks is off in all 1 scope(s) evaluated');
        expect(rendered).not.toContain('everywhere');
    });

    test('always repeats that the sites are candidates, not defects', () => {
        expect(reportScan(result())).toContain('candidates, not proven defects');
    });
});

test('a long-winded diagnostic does not drown the report', () => {
    const rendered = reportScan({
        guarantees: [
            {
                path: 'apps/player/tsconfig.json',
                guarantees: {
                    kind: 'unresolved',
                    path: 'apps/player/tsconfig.json',
                    reason: `Argument for '--lib' option must be: ${Array.from({ length: 90 }, (_, i) => `'es20${i}'`).join(', ')}.`,
                },
            },
        ],
        sites: [],
        filesScanned: 1,
        unreadable: [],
        skipped: new Map(),
        testsExcluded: 0,
        ignored: { files: 0, sites: 0 },
        refused: [],
    });

    expect(rendered).toContain('has an unrecognised value');
    expect(rendered).not.toContain("'es2042'");
    for (const line of rendered.split('\n')) {
        expect(line.length).toBeLessThan(220);
    }
});
