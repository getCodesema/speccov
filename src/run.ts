import type { Measurement, Rule, Verdict } from './rule';

/**
 * Runs each rule and classifies the result.
 *
 * A written rule that is violated is a violation — a bug. A default rule that is violated
 * is a gap — a question, not an accusation: nobody ever wrote that this behaviour was
 * forbidden.
 *
 * And a rule held without ever being exercised is vacuous: it proved nothing.
 */
export async function run(rules: readonly Rule[]): Promise<readonly Verdict[]> {
    const verdicts: Verdict[] = [];
    for (const rule of rules) {
        const measurements = await rule.measure();
        const { held, detail, magnitude, exercised } = rule.judge(measurements);

        if (held && !exercised) {
            // Green having seen nothing: the textbook case of vacuity. It cannot sit with
            // the rules held, it held nothing.
            verdicts.push({
                kind: 'vacuous',
                rule,
                measurements,
                magnitude,
                detail,
                question: `${detail}. The rule was never put to the test — what was it meant to check?`,
            });
        } else if (held) {
            verdicts.push(
                atBoundary(rule, measurements)
                    ? {
                          kind: 'borderline',
                          rule,
                          measurements,
                          magnitude,
                          detail,
                          question: `${detail}. One notch stricter and the rule would fall — was the threshold chosen, or fitted to what we observed?`,
                      }
                    : { kind: 'held', rule, measurements, magnitude, detail },
            );
        } else if (rule.origin === 'declared') {
            verdicts.push({ kind: 'infraction', rule, measurements, magnitude, detail });
        } else {
            verdicts.push({
                kind: 'lacuna',
                rule,
                measurements,
                magnitude,
                detail,
                question: `${detail}. No written rule forbids it. Is this intended?`,
            });
        }
    }
    return verdicts;
}

/**
 * Rejudges the same measurements with the rule one notch stricter.
 *
 * Nothing is re-run: `judge()` is pure on its argument, so the probe costs a single call.
 * A rule with no stricter variant has no margin to question.
 */
function atBoundary(rule: Rule, measurements: readonly Measurement[]): boolean {
    const stricter = rule.tighten?.();
    if (stricter === undefined) {
        return false;
    }
    return !stricter.judge(measurements).held;
}
