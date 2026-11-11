import { version as tsVersion } from 'typescript';
import type { Guarantees } from './guarantees';
import type { ShapeKind, Site } from './shapes';

/** A tsconfig and what it proves. A monorepo has several, of differing strictness. */
export type Scope = {
    readonly path: string;
    readonly guarantees: Guarantees;
};

export type ScanResult = {
    /** Empty when no tsconfig was found or given. */
    readonly guarantees: readonly Scope[];
    readonly sites: readonly Site[];
    readonly filesScanned: number;
    /** Paths the walk could not open, a directory the mode refuses among them. Counted, never silenced. */
    readonly unreadable: readonly string[];
    /** Code files left unparsed, by extension. Declared, never silenced. */
    readonly skipped: ReadonlyMap<string, number>;
    /** Test files deliberately set aside. */
    readonly testsExcluded: number;
    /** What the project's `.speccovignore` left out. Counted, never silenced. */
    readonly ignored: { readonly files: number; readonly sites: number };
    /** Scopes whose program could not be built. Declared, never guessed at. */
    readonly refused: readonly { readonly path: string; readonly reason: string }[];
};

type Candidate = { readonly kind: ShapeKind; readonly rule: string; readonly question: string };

const UNBOUNDED_PRIMITIVE: Candidate = {
    kind: 'unbounded-primitive',
    rule: 'forbidden()',
    question: 'this parameter takes the whole primitive domain (empty string, NaN, negative, unbounded): what is the limit?',
};

const CANDIDATES: readonly Candidate[] = [
    {
        kind: 'unbounded-fanout',
        rule: 'resource()',
        question: 'outgoing concurrency follows the size of the collection — what is the ceiling?',
    },
    {
        kind: 'async-per-item',
        rule: 'complexity()',
        question: 'one asynchronous call per item — should their number grow?',
    },
    {
        kind: 'awaited-in-loop',
        rule: 'complexity()',
        question: 'one awaited call per item, in series — should the wait grow with the collection?',
    },
    {
        kind: 'paginated-return',
        rule: 'metamorphic()',
        question: 'should `total` stay the same whatever the page?',
    },
    UNBOUNDED_PRIMITIVE,
];

const MAX_SITES_SHOWN = 6;

function isEnabled(scope: Scope, flag: string): boolean {
    return scope.guarantees.kind === 'read' && (scope.guarantees.flags.find((entry) => entry.flag === flag)?.enabled ?? false);
}

const MAX_LISTED = 3;

function list(values: readonly string[]): string {
    const shown = values.slice(0, MAX_LISTED).join(', ');
    return values.length > MAX_LISTED ? `${shown} … and ${values.length - MAX_LISTED} more` : shown;
}

/**
 * For each flag: what it proves, and the scopes read where it is off.
 *
 * Extracted so that the prose and the JSON start from the same source. Two parallel
 * aggregations would end up diverging, and a report that contradicts itself is worth nothing.
 */
export function flagCoverage(result: ScanResult): readonly FlagCoverage[] {
    const readable = result.guarantees.flatMap((scope) => (scope.guarantees.kind === 'read' ? [scope] : []));
    const [first] = readable;
    const flags = first?.guarantees.kind === 'read' ? first.guarantees.flags : [];

    return flags.map(({ flag, proves }) => ({
        flag,
        proves,
        scopesEvaluated: readable.length,
        offIn: readable.filter((scope) => !isEnabled(scope, flag)).map(({ path }) => path),
    }));
}

export type FlagCoverage = {
    readonly flag: string;
    readonly proves: string;
    readonly scopesEvaluated: number;
    readonly offIn: readonly string[];
};

export { CANDIDATES };

export function reportScan(result: ScanResult, accepted: readonly Site[] = []): string {
    const lines = ['', `  ${result.filesScanned} files read, nothing executed.`, ''];

    const readable = result.guarantees.flatMap((scope) => (scope.guarantees.kind === 'read' ? [scope] : []));
    const everywhere: string[] = [];
    const partial: string[] = [];

    for (const { flag, proves, offIn: missing } of flagCoverage(result)) {
        const scope = readable.length > 1 ? `, ${readable.length} scopes evaluated` : '';
        if (missing.length === 0) {
            everywhere.push(`     ✓ ${proves}  (${flag}${scope})`);
        } else if (missing.length === readable.length) {
            // Never "everywhere": the conclusion bears only on the scopes read.
            partial.push(`     ⚠ ${proves} — ${flag} is off in all ${readable.length} scope(s) evaluated`);
        } else {
            partial.push(`     ⚠ ${proves} — ${flag} is off in ${list(missing)}`);
        }
    }

    const bounded = result.sites.filter(({ kind }) => kind === 'bounded-fanout');
    const drains = result.sites.filter(({ kind }) => kind === 'in-flight-drain');
    lines.push('  ── Proven by construction ─────────────────────────────────');
    lines.push(...everywhere);
    if (bounded.length > 0) {
        const plural = bounded.length > 1 ? 's' : '';
        lines.push(
            `     ✓ ${bounded.length} fan-out${plural} bounded in writing (array literal or a constant written somewhere)`,
        );
    }
    // Counted and said out loud, like everything this pass sets aside. A silenced drain would
    // read as a site never looked at.
    if (drains.length > 0) {
        const plural = drains.length > 1 ? 's' : '';
        lines.push(`     ✓ ${drains.length} wait${plural} on promises already in flight (started elsewhere, opens nothing)`);
    }
    if (everywhere.length === 0 && bounded.length === 0 && drains.length === 0) {
        lines.push('     nothing to declare');
    }

    lines.push('', '  ── Guaranteed by nobody ───────────────────────────────────');
    const unread = result.guarantees.length - readable.length;
    if (partial.length > 0 && unread > 0) {
        lines.push(`     (reach: ${readable.length} of ${result.guarantees.length} scope(s) — see “Not measured”)`);
    }
    lines.push(...partial);
    for (const { kind, rule, question } of CANDIDATES) {
        const sites = result.sites.filter((site) => site.kind === kind);
        if (sites.length === 0 || kind === UNBOUNDED_PRIMITIVE.kind) {
            continue;
        }
        lines.push('', `     ⚠ ${sites.length} site(s) → ${rule}: ${question}`);
        for (const site of sites.slice(0, MAX_SITES_SHOWN)) {
            lines.push(`         ${site.file}:${site.line}  ${site.excerpt}`);
        }
        if (sites.length > MAX_SITES_SHOWN) {
            lines.push(`         … and ${sites.length - MAX_SITES_SHOWN} more`);
        }
    }

    // Counted and never hidden, exactly as in `report()`: a forgotten acceptance is the blind
    // spot this whole tool exists to refuse.
    if (accepted.length > 0) {
        const plural = accepted.length > 1 ? 's' : '';
        lines.push('', `     · ${accepted.length} site${plural} already answered (see the scan answers file)`);
    }

    lines.push(...typedNotBounded(result.sites));

    lines.push('', '  ── Not measured ───────────────────────────────────────────');
    lines.push('     This pass is static: no behaviour was observed.');
    if (result.guarantees.length === 0) {
        lines.push('     No tsconfig found: nothing is said about construction guarantees.');
    }
    const unresolved = result.guarantees.flatMap((scope) =>
        scope.guarantees.kind === 'unresolved' ? [`${scope.path} (${brief(scope.guarantees.reason)})`] : [],
    );
    const unrecognised = result.guarantees.flatMap((scope) =>
        scope.guarantees.kind === 'read' && scope.guarantees.unrecognised.length > 0
            ? [`${scope.path} (${scope.guarantees.unrecognised.map((option) => `--${option}`).join(', ')})`]
            : [],
    );
    if (unrecognised.length > 0) {
        lines.push(`     ${unrecognised.length} scope(s) with an unrecognised option: ${list(unrecognised)}`);
        lines.push(`     speccov reads tsconfig with TypeScript ${tsVersion}. Those values are unknown`);
        lines.push('     to it — newer, most likely. The flags above stay correct: the file was');
        lines.push('     resolved, only the value of those options was not.');
    }
    if (unresolved.length > 0) {
        lines.push(`     ${unresolved.length} unresolved tsconfig(s): ${list(unresolved)}`);
        lines.push('     Nothing is concluded for those scopes: an unresolved "extends" makes');
        lines.push('     TypeScript fall back to its defaults in silence, and concluding here');
        lines.push('     would produce false alarms.');
        lines.push('     An "extends" pointing at a package assumes its dependencies are installed:');
        lines.push('     run again after installing to populate "Proven by construction".');
    }
    if (result.refused.length > 0) {
        lines.push(
            `     ${result.refused.length} scope(s) whose program could not be built: ${list(
                result.refused.map(({ path, reason }) => `${path} (${brief(reason)})`),
            )}`,
        );
        lines.push('     No site is reported for those scopes. speccov reads types now, and');
        lines.push('     falling back to guessing by method name would reintroduce exactly the');
        lines.push('     false positives the type checker removes — under a look of rigour.');
    }
    lines.push('     The sites above are candidates, not proven defects.');
    for (const [extension, count] of [...result.skipped].sort(([, a], [, b]) => b - a)) {
        lines.push(`     ${count} .${extension} file(s) not read: speccov only parses TypeScript.`);
    }
    if (result.testsExcluded > 0) {
        lines.push(`     ${result.testsExcluded} test file(s) deliberately excluded.`);
    }
    if (result.ignored.files > 0) {
        lines.push(
            `     ${result.ignored.files} file(s) set aside by .speccovignore, ${result.ignored.sites} site(s) with them.`,
        );
    }
    if (result.unreadable.length > 0) {
        lines.push(`     ${result.unreadable.length} unreadable path(s): ${result.unreadable.slice(0, 3).join(', ')}`);
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * The parameters whose type states no bound, in a block of their own.
 *
 * The other candidates describe a behaviour: calls that grow with a collection. This one
 * describes a type, and there are many more of them: listed alongside, a few hundred
 * signatures bury the handful of fan-outs. So the block gives the size of the question and
 * where it concentrates, file by file. Nothing is dropped: every site is in the JSON.
 */
function typedNotBounded(sites: readonly Site[]): readonly string[] {
    const perFile = new Map<string, number>();
    for (const { kind, file } of sites) {
        if (kind === UNBOUNDED_PRIMITIVE.kind) {
            perFile.set(file, (perFile.get(file) ?? 0) + 1);
        }
    }
    if (perFile.size === 0) {
        return [];
    }
    const total = [...perFile.values()].reduce((sum, count) => sum + count, 0);
    const ranked = [...perFile].sort(([left, a], [right, b]) => b - a || left.localeCompare(right));
    const lines = [
        '',
        '  ── Typed, not bounded ─────────────────────────────────────',
        `     ⚠ ${total} parameter(s) in ${perFile.size} file(s) → ${UNBOUNDED_PRIMITIVE.rule}: ${UNBOUNDED_PRIMITIVE.question}`,
        ...ranked.slice(0, MAX_SITES_SHOWN).map(([file, count]) => `         ${file}  ${count}`),
    ];
    if (ranked.length > MAX_SITES_SHOWN) {
        lines.push(`         … and ${ranked.length - MAX_SITES_SHOWN} more file(s)`);
    }
    lines.push('     A property of the type, not an observed behaviour. Every site is in the --json output.');
    return lines;
}

/**
 * A TypeScript diagnostic can enumerate every value an option admits — thousands of
 * characters to say that one of them is wrong. Dumped as-is, it drowns the rest of the
 * report, and a report nobody can read is no longer of any use for deciding.
 */
function brief(reason: string): string {
    const enumeration = reason.indexOf(' must be: ');
    const cut = enumeration === -1 ? reason : `${reason.slice(0, enumeration)} has an unrecognised value`;
    return cut.length <= 120 ? cut : `${cut.slice(0, 119)}…`;
}
