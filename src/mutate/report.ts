import type { MutateResult, Outcome } from './run';

const MAX_SHOWN = 8;

/**
 * A surviving mutant is a question, not an accusation: the behaviour changed and nobody
 * said a word. Whether somebody should have is what is left to settle.
 */
/**
 * `all` exists for triage: eight survivors are enough to alert a human, never enough to
 * decide what to fix when there are a hundred. Truncating by default keeps the report readable;
 * never being able to see it all would make it unusable.
 */
export function reportMutants(result: MutateResult, all = false): string {
    const survivors = result.outcomes.filter(({ fate }) => fate === 'survived');
    const killed = result.outcomes.length - survivors.length;

    const lines = ['', `  ${result.outcomes.length} mutants tried, ${killed} killed.`];
    if (survivors.length === 0) {
        lines.push('', '  No survivor: every alteration of the code was caught.');
    } else {
        lines.push(`  ⚠ ${survivors.length} survivor(s) — that many behaviours nobody guarantees.`, '');
        const shown = all ? survivors.length : MAX_SHOWN;
        for (const [index, outcome] of survivors.slice(0, shown).entries()) {
            lines.push(...describe(outcome, index + 1, survivors.length));
        }
        if (survivors.length > shown) {
            lines.push(`  … and ${survivors.length - shown} more survivor(s) — run again with --all to see them.`);
        }
    }
    if (result.skipped > 0) {
        lines.push('', '  ── Not measured ───────────────────────────────────────────');
        lines.push(`     ${result.skipped} mutant(s) generated but not tried, out of budget.`);
        lines.push('     Raise --limit or narrow the scope.');
    }
    lines.push('');
    return lines.join('\n');
}

function describe({ mutant }: Outcome, position: number, total: number): readonly string[] {
    return [
        `  survivor ${position}/${total}   ${mutant.file}:${mutant.line}  (${mutant.mutator})`,
        `  “I replaced  ${truncate(mutant.original)}  with  ${truncate(mutant.replacement)}  and nothing`,
        '    objected. Should this behaviour be guaranteed?”',
        '',
    ];
}

function truncate(text: string): string {
    const single = text.replaceAll(/\s+/gu, ' ');
    return single.length <= 40 ? single : `${single.slice(0, 40)}…`;
}
