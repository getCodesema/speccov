import type { Borderline, Infraction, Lacuna, Vacuous, Verdict } from './rule';

/**
 * Makes the verdict readable. The report is dominated by what is not guaranteed: a success
 * carries no information, it fits on a single line.
 */
export function report(verdicts: readonly Verdict[], accepted: readonly Lacuna[] = []): string {
    const held = verdicts.filter((verdict) => verdict.kind === 'held');
    const infractions = verdicts.filter((verdict): verdict is Infraction => verdict.kind === 'infraction');
    const lacunae = verdicts.filter((verdict): verdict is Lacuna => verdict.kind === 'lacuna');
    const vacuous = verdicts.filter((verdict): verdict is Vacuous => verdict.kind === 'vacuous');
    const borderline = verdicts.filter((verdict): verdict is Borderline => verdict.kind === 'borderline');

    const lines = [''];
    if (held.length > 0) {
        // No tick when nothing is held: a ✓ in front of zero reads wrong.
        lines.push(`  ✓ ${count(held.length, 'rule held', 'rules held')}`);
    }
    if (infractions.length > 0) {
        lines.push(`  ✗ ${count(infractions.length, 'violation', 'violations')}`);
    }
    if (lacunae.length > 0) {
        lines.push(`  ⚠ ${count(lacunae.length, 'gap', 'gaps')}`);
    }
    if (vacuous.length > 0) {
        lines.push(`  ? ${count(vacuous.length, 'rule never exercised', 'rules never exercised')}`);
    }
    if (borderline.length > 0) {
        lines.push(`  ~ ${count(borderline.length, 'rule held with no margin', 'rules held with no margin')}`);
    }
    if (accepted.length > 0) {
        // Counted and never hidden: a forgotten acceptance is a blind spot.
        lines.push(`  · ${count(accepted.length, 'gap already accepted', 'gaps already accepted')}`);
    }

    infractions.forEach((infraction, index) => {
        lines.push('', `  violation ${index + 1}/${infractions.length}   ${infraction.rule.name}`);
        lines.push(indent(`“${infraction.rule.intention}” does not hold.`));
        lines.push(indent(infraction.detail));
    });

    lacunae.forEach((lacuna, index) => {
        lines.push('', `  gap ${index + 1}/${lacunae.length}   ${lacuna.rule.name}`);
        lines.push(indent(`“${lacuna.question}”`));
        lines.push('', '     [y] this is a bug     [n] this is intended');
    });

    vacuous.forEach((verdict, index) => {
        lines.push('', `  never exercised ${index + 1}/${vacuous.length}   ${verdict.rule.name}`);
        lines.push(indent(`“${verdict.question}”`));
        lines.push(indent('It is green because it saw nothing, not because it judged.'));
    });

    borderline.forEach((verdict, index) => {
        lines.push('', `  no margin ${index + 1}/${borderline.length}   ${verdict.rule.name}`);
        lines.push(indent(`“${verdict.question}”`));
    });

    if (infractions.length === 0 && lacunae.length === 0 && vacuous.length === 0 && borderline.length === 0) {
        lines.push('', '  Nothing to report.');
    }

    const notMeasured = measurementWindow(verdicts);
    lines.push('', '  ── Not measured ──────────────────────────────────────────');
    if (notMeasured.largest === null) {
        lines.push('     No input size was exercised: nothing is said about how cost grows.');
    } else {
        lines.push(`     Input sizes tried: ${notMeasured.sizes.join(', ')} — nothing beyond ${notMeasured.largest}.`);
        lines.push('     A cost that only grows past that size would not have been seen.');
    }
    if (notMeasured.unobserved.length > 0) {
        lines.push(
            `     ${count(notMeasured.unobserved.length, 'rule observed nothing', 'rules observed nothing')}: ${notMeasured.unobserved.join(', ')}`,
        );
    }
    lines.push('     The data comes from the rule file, not from production.');
    lines.push('');
    return lines.join('\n');
}

/** What the pass actually observed — and so, in negative, what it did not see. */
export type MeasurementWindow = {
    /** Distinct input sizes actually tried, sorted. */
    readonly sizes: readonly number[];
    /** The largest size tried, or `null` if no rule measured anything. */
    readonly largest: number | null;
    /** Rules that observed no measurement: they bound nothing at all. */
    readonly unobserved: readonly string[];
};

/**
 * A rule concludes only about the sizes it tried. Keeping that bound quiet would make a
 * green report read as "cost never grows", when it only says "not up to 16". That is the
 * exact charge levelled at 90% coverage.
 *
 * Prose and JSON both start here so they cannot contradict each other.
 */
export function measurementWindow(verdicts: readonly Verdict[]): MeasurementWindow {
    const sizes = new Set<number>();
    const unobserved: string[] = [];

    for (const verdict of verdicts) {
        if (verdict.measurements.length === 0) {
            unobserved.push(verdict.rule.name);
        }
        for (const { size } of verdict.measurements) {
            sizes.add(size);
        }
    }

    const sorted = [...sizes].sort((a, b) => a - b);
    return { sizes: sorted, largest: sorted.at(-1) ?? null, unobserved };
}

/** Only a violation fails the run: a gap is a question, not a refusal. */
export function exitCode(verdicts: readonly Verdict[]): number {
    return verdicts.some((verdict) => verdict.kind === 'infraction') ? 1 : 0;
}

function count(value: number, singular: string, plural: string): string {
    return `${value} ${value > 1 ? plural : singular}`;
}

const WIDTH = 88;

/** Wraps the text so a report stays readable in a narrow terminal. */
function indent(text: string): string {
    const lines: string[] = [];
    let current = '';
    for (const word of text.split(/\s+/).filter((part) => part !== '')) {
        const candidate = current === '' ? word : `${current} ${word}`;
        if (candidate.length > WIDTH && current !== '') {
            lines.push(current);
            current = word;
        } else {
            current = candidate;
        }
    }
    if (current !== '') {
        lines.push(current);
    }
    return lines.map((line) => `  ${line}`).join('\n');
}
