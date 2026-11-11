import { describe, expect, test } from 'bun:test';
import { mutantsToJson, scanToJson, verdictsToJson } from './json';
import type { ScanResult } from './scan/report';
import { report } from './report';
import { reportScan } from './scan/report';
import type { Rule, Verdict } from './rule';

const FLAG = { flag: 'strictNullChecks', proves: 'no value is implicitly nullable', enabled: true };

function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
    return {
        guarantees: [{ path: 'a/tsconfig.json', guarantees: { kind: 'read', flags: [FLAG], unrecognised: [] } }],
        sites: [],
        filesScanned: 10,
        unreadable: [],
        skipped: new Map(),
        testsExcluded: 0,
        refused: [],
        ...overrides,
    };
}

describe('scanToJson', () => {
    test('carries the schema number and the command', () => {
        const payload = JSON.parse(scanToJson(scanResult()));

        expect(payload.speccov).toBe(1);
        expect(payload.command).toBe('scan');
    });

    test('a flag on everywhere is a proof, not an alert', () => {
        const payload = JSON.parse(scanToJson(scanResult()));

        expect(payload.provenByConstruction.flags).toEqual([{ flag: FLAG.flag, proves: FLAG.proves }]);
        expect(payload.guaranteedByNobody.flags).toEqual([]);
    });

    /**
     * The refusal has to travel. Without it, an agent would read the absence of an alert as a
     * green light — the one lie this tool cannot afford.
     */
    test('an unresolved scope shows up in the JSON', () => {
        const payload = JSON.parse(
            scanToJson(
                scanResult({
                    guarantees: [
                        {
                            path: 'a/tsconfig.json',
                            guarantees: { kind: 'unresolved', path: 'a/tsconfig.json', reason: 'not found' },
                        },
                    ],
                }),
            ),
        );

        expect(payload.notMeasured.unresolvedScopes).toEqual([{ path: 'a/tsconfig.json', reason: 'not found' }]);
        expect(payload.provenByConstruction.flags).toEqual([]);
    });

    test('files not parsed, tests excluded and unreadable ones are declared', () => {
        const payload = JSON.parse(
            scanToJson(
                scanResult({
                    skipped: new Map([['vue', 188]]),
                    testsExcluded: 412,
                    refused: [],
                    unreadable: ['broken.ts'],
                }),
            ),
        );

        expect(payload.notMeasured.filesNotParsed).toEqual({ vue: 188 });
        expect(payload.notMeasured.testsExcluded).toBe(412);
        expect(payload.notMeasured.unreadable).toEqual(['broken.ts']);
        // The note tells the agent what this pass did NOT do. Keeping it quiet would be a green light.
        expect(payload.notMeasured.behaviour).toBe('this pass is static; nothing was executed');
    });

    /**
     * Prose and JSON both start from `flagCoverage`. This test holds the two together: an
     * aggregation that drifted would produce a report that contradicts itself.
     */
    test('the JSON and the prose count the same flags that are off', () => {
        const result = scanResult({
            guarantees: [
                { path: 'a/tsconfig.json', guarantees: { kind: 'read', flags: [FLAG], unrecognised: [] } },
                { path: 'b/tsconfig.json', guarantees: { kind: 'read', flags: [{ ...FLAG, enabled: false }], unrecognised: [] } },
            ],
        });
        const payload = JSON.parse(scanToJson(result));

        expect(payload.guaranteedByNobody.flags).toEqual([{ flag: FLAG.flag, proves: FLAG.proves, offIn: ['b/tsconfig.json'] }]);
        expect(reportScan(result)).toContain('strictNullChecks is off in b/tsconfig.json');
    });

    /**
     * `typesResolved` is the one line of the payload an agent can read as a green light. It has
     * to cover BOTH failures: the refused program and the unresolved tsconfig. Announcing it
     * true next to a full `unresolvedScopes` would be the lie by omission this output exists
     * to forbid.
     */
    test('an unresolved scope turns typesResolved off, even with no refusal', () => {
        const payload = JSON.parse(
            scanToJson(
                scanResult({
                    guarantees: [
                        { path: 'a/tsconfig.json', guarantees: { kind: 'unresolved', path: 'a', reason: 'extends not found' } },
                    ],
                    refused: [],
                }),
            ),
        );

        expect(payload.notMeasured.typesResolved).toBe(false);
        expect(payload.notMeasured.unresolvedScopes).toEqual([{ path: 'a/tsconfig.json', reason: 'extends not found' }]);
    });

    test('a refused program turns typesResolved off, and everything read turns it back on', () => {
        const refused = JSON.parse(scanToJson(scanResult({ refused: [{ path: 'b', reason: 'no input file in this scope' }] })));
        const clean = JSON.parse(scanToJson(scanResult()));

        expect(refused.notMeasured.typesResolved).toBe(false);
        expect(clean.notMeasured.typesResolved).toBe(true);
    });
});

describe('verdictsToJson', () => {
    const rule = {
        name: 'subject',
        intention: 'The number of queries does not grow with the input size',
        origin: 'default',
        measure: async () => [],
        judge: () => ({ held: false, exercised: true, magnitude: 1, detail: 'does not matter' }),
    } satisfies Rule;

    /**
     * `rules` was the only one of the three commands without a "not measured" section. Without
     * it, an agent reads "1 rule held" as "cost never grows", when the pass only says "not up
     * to the largest size tried".
     */
    test('the measurement window is declared, and the prose says the same', () => {
        const held: Verdict = {
            kind: 'held',
            rule,
            measurements: [
                { size: 16, cost: 16 },
                { size: 1, cost: 1 },
            ],
            magnitude: 0,
            detail: 'constant',
        };
        const payload = JSON.parse(verdictsToJson([held], [], 0));

        expect(payload.notMeasured.inputSizesTried).toEqual([1, 16]);
        expect(payload.notMeasured.largestSizeTried).toBe(16);
        expect(payload.notMeasured.rulesWithoutMeasurement).toEqual([]);
        expect(report([held])).toContain('nothing beyond 16');
    });

    test('a rule with no measurement is named in the not-measured section', () => {
        const blind: Verdict = { kind: 'held', rule, measurements: [], magnitude: 0, detail: 'constant' };
        const payload = JSON.parse(verdictsToJson([blind], [], 0));

        expect(payload.notMeasured.largestSizeTried).toBeNull();
        expect(payload.notMeasured.rulesWithoutMeasurement).toEqual(['subject']);
    });

    test("a gap's question travels, and so does the exit code", () => {
        const lacuna: Verdict = {
            kind: 'lacuna',
            rule,
            measurements: [{ size: 1, cost: 2 }],
            magnitude: 1,
            detail: 'grows by ≈ 1 per item',
            question: 'Is this intended?',
        };
        const payload = JSON.parse(verdictsToJson([lacuna], [], 0));

        expect(payload.speccov).toBe(1);
        expect(payload.command).toBe('rules');
        expect(payload.exitCode).toBe(0);
        expect(payload.verdicts[0]).toEqual({
            kind: 'lacuna',
            rule: 'subject',
            intention: rule.intention,
            origin: 'default',
            detail: 'grows by ≈ 1 per item',
            magnitude: 1,
            question: 'Is this intended?',
            measurements: [{ size: 1, cost: 2 }],
        });
    });

    test('a rule held carries no question', () => {
        const held: Verdict = { kind: 'held', rule, measurements: [], magnitude: 0, detail: 'ok' };
        const payload = JSON.parse(verdictsToJson([held], [], 0));

        expect(payload.verdicts[0].question).toBeUndefined();
    });
});

describe('scanToJson — candidates and unrecognised options', () => {
    test('sites are grouped by the rule proposed', () => {
        const payload = JSON.parse(
            scanToJson(
                scanResult({
                    sites: [
                        { kind: 'unbounded-fanout', file: 'a.ts', line: 3, excerpt: 'Promise.all(xs.map(f))' },
                        { kind: 'unbounded-fanout', file: 'b.ts', line: 9, excerpt: 'Promise.all(ys.map(g))' },
                        { kind: 'bounded-fanout', file: 'c.ts', line: 1, excerpt: 'Promise.all([a, b])' },
                    ],
                }),
            ),
        );

        expect(payload.provenByConstruction.boundedFanOut).toBe(1);
        expect(payload.guaranteedByNobody.candidates).toHaveLength(1);
        expect(payload.guaranteedByNobody.candidates[0].rule).toBe('resource()');
        expect(payload.guaranteedByNobody.candidates[0].sites).toEqual([
            { file: 'a.ts', line: 3, excerpt: 'Promise.all(xs.map(f))' },
            { file: 'b.ts', line: 9, excerpt: 'Promise.all(ys.map(g))' },
        ]);
    });

    test('an option the bundled compiler does not recognise is declared', () => {
        const payload = JSON.parse(
            scanToJson(
                scanResult({
                    guarantees: [
                        {
                            path: 'a/tsconfig.json',
                            guarantees: { kind: 'read', flags: [FLAG], unrecognised: ['lib', 'target'] },
                        },
                    ],
                }),
            ),
        );

        expect(payload.notMeasured.unrecognisedOptions).toEqual([{ path: 'a/tsconfig.json', options: ['lib', 'target'] }]);
        // The flags stay read: an unknown value does not distort what we read.
        expect(payload.provenByConstruction.flags).toHaveLength(1);
    });

    test('a scope with no doubtful option does not show up in the list', () => {
        const payload = JSON.parse(scanToJson(scanResult()));

        expect(payload.notMeasured.unrecognisedOptions).toEqual([]);
    });
});

describe('mutantsToJson', () => {
    const mutant = {
        id: 'x',
        file: 'src/a.ts',
        line: 12,
        mutator: 'comparison',
        start: 0,
        end: 1,
        original: '>',
        replacement: '>=',
    };

    test('counts the killed without listing them, and names the survivors', () => {
        const payload = JSON.parse(
            mutantsToJson(
                {
                    outcomes: [
                        { mutant, fate: 'killed' },
                        { mutant: { ...mutant, line: 30 }, fate: 'survived' },
                    ],
                    skipped: 7,
                },
                0,
            ),
        );

        expect(payload).toEqual({
            speccov: 1,
            command: 'mutate',
            exitCode: 0,
            tried: 2,
            killed: 1,
            survivors: [{ file: 'src/a.ts', line: 30, mutator: 'comparison', original: '>', replacement: '>=' }],
            notMeasured: { generatedButNotTried: 7 },
        });
    });

    test('no survivor gives an empty list, never a missing field', () => {
        const payload = JSON.parse(mutantsToJson({ outcomes: [{ mutant, fate: 'killed' }], skipped: 0 }, 0));

        expect(payload.survivors).toEqual([]);
        expect(payload.killed).toBe(1);
    });
});
