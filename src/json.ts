import type { MutateResult } from './mutate/run';
import { measurementWindow } from './report';
import type { Verdict } from './rule';
import { CANDIDATES, flagCoverage, type ScanResult } from './scan/report';
import type { Site } from './scan/shapes';

/**
 * Machine-readable output.
 *
 * This is the real product: speccov's thesis is that an agent reads the verdict and acts.
 * Making it parse prose wrapped at 88 columns would ask it to guess — exactly the brittle
 * thing speccov exists to replace.
 *
 * The schema carries the same refusals as the prose. An unresolved scope shows up here too:
 * without it, the absence of an alert would read as a green light, which is the one lie
 * this tool cannot afford.
 */
const SCHEMA = 1;

export function scanToJson(result: ScanResult, accepted: readonly Site[] = []): string {
    const coverage = flagCoverage(result);
    const [scopesEvaluated = 0] = coverage.map(({ scopesEvaluated: n }) => n);

    return stringify({
        speccov: SCHEMA,
        command: 'scan',
        filesScanned: result.filesScanned,
        scopes: { evaluated: scopesEvaluated, found: result.guarantees.length },
        provenByConstruction: {
            flags: coverage.filter(({ offIn }) => offIn.length === 0).map(({ flag, proves }) => ({ flag, proves })),
            boundedFanOut: result.sites.filter(({ kind }) => kind === 'bounded-fanout').length,
            awaitedInFlight: result.sites.filter(({ kind }) => kind === 'in-flight-drain').length,
        },
        alreadyAnswered: {
            count: accepted.length,
            sites: accepted.map(({ file, line, excerpt }) => ({ file, line, excerpt })),
        },
        guaranteedByNobody: {
            flags: coverage.filter(({ offIn }) => offIn.length > 0).map(({ flag, proves, offIn }) => ({ flag, proves, offIn })),
            candidates: CANDIDATES.flatMap(({ kind, rule, question }) => {
                const sites = result.sites.filter((site) => site.kind === kind);
                return sites.length === 0
                    ? []
                    : [{ rule, question, sites: sites.map(({ file, line, excerpt }) => ({ file, line, excerpt })) }];
            }),
        },
        notMeasured: {
            behaviour: 'this pass is static; nothing was executed',
            // Two distinct failures stop a scope from being read: the refused program
            // (`program.ts`) and the unresolved tsconfig (`guarantees.ts`). Looking at only one
            // would announce "types resolved" next to a full `unresolvedScopes` — a green light.
            typesResolved:
                result.refused.length === 0 && result.guarantees.every(({ guarantees }) => guarantees.kind !== 'unresolved'),
            unresolvedScopes: result.guarantees.flatMap((scope) =>
                scope.guarantees.kind === 'unresolved' ? [{ path: scope.path, reason: scope.guarantees.reason }] : [],
            ),
            unrecognisedOptions: result.guarantees.flatMap((scope) =>
                scope.guarantees.kind === 'read' && scope.guarantees.unrecognised.length > 0
                    ? [{ path: scope.path, options: [...scope.guarantees.unrecognised] }]
                    : [],
            ),
            filesNotParsed: Object.fromEntries(result.skipped),
            testsExcluded: result.testsExcluded,
            ignored: { files: result.ignored.files, sites: result.ignored.sites },
            unreadable: [...result.unreadable],
            refusedScopes: result.refused.map(({ path, reason }) => ({ path, reason })),
        },
    });
}

export function verdictsToJson(verdicts: readonly Verdict[], accepted: readonly Verdict[], exitCode: number): string {
    const window = measurementWindow(verdicts);

    return stringify({
        speccov: SCHEMA,
        command: 'rules',
        exitCode,
        verdicts: verdicts.map((verdict) => ({
            kind: verdict.kind,
            rule: verdict.rule.name,
            intention: verdict.rule.intention,
            origin: verdict.rule.origin,
            detail: verdict.detail,
            magnitude: verdict.magnitude,
            ...('question' in verdict ? { question: verdict.question } : {}),
            measurements: verdict.measurements.map(({ size, cost }) => ({ size, cost })),
        })),
        alreadyAccepted: accepted.map((verdict) => verdict.rule.name),
        notMeasured: {
            inputSizesTried: window.sizes,
            largestSizeTried: window.largest,
            rulesWithoutMeasurement: window.unobserved,
            dataShape: 'the rule file builds its own data; no production shape was observed',
        },
    });
}

export function mutantsToJson(result: MutateResult, exitCode: number): string {
    const survivors = result.outcomes.filter(({ fate }) => fate === 'survived');

    return stringify({
        speccov: SCHEMA,
        command: 'mutate',
        exitCode,
        tried: result.outcomes.length,
        killed: result.outcomes.length - survivors.length,
        survivors: survivors.map(({ mutant }) => ({
            file: mutant.file,
            line: mutant.line,
            mutator: mutant.mutator,
            original: mutant.original,
            replacement: mutant.replacement,
        })),
        notMeasured: { generatedButNotTried: result.skipped },
    });
}

/** Indented: a human sometimes rereads what their agent read, and a CI diff has to stay legible. */
function stringify(payload: unknown): string {
    return JSON.stringify(payload, undefined, 2);
}
