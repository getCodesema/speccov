/**
 * A *declared* rule was written by a human: breaking it is an infraction.
 * A *default* rule was written by nobody: breaking it is not a proven bug,
 * it is a question to ask — a gap.
 */
export type Origin = 'declared' | 'default';

/** The cost observed for a given input size. */
export type Measurement = {
    readonly size: number;
    readonly cost: number;
};

export type Judgement = {
    readonly held: boolean;
    /** Factual sentence describing what was measured. Never a value judgement. */
    readonly detail: string;
    /**
     * How far past the threshold, monotonic: the larger it is, the more the rule is violated.
     *
     * Mandatory, and that is a choice: a rule unable to quantify its own gap cannot be
     * accepted at a threshold, so the human answer to it cannot be mechanised.
     */
    readonly magnitude: number;
    /**
     * True if the measurements held at least one observation able to make the rule fail.
     * False when it "held" without ever being exercised.
     *
     * This is vacuity, described for twenty years in formal verification: a property
     * satisfied for a trivial reason. About one specification in five passes that way on
     * the first checks, and a vacuous pass always points at a real problem — in the code,
     * in the rule, or in what was measured.
     *
     * Mandatory, like `magnitude`: a rule unable to say whether it was ever exercised cannot
     * be told apart from a rule that is green by absence.
     */
    readonly exercised: boolean;
};

export type Rule = {
    readonly name: string;
    /** Human-readable sentence. Mandatory: a rule that says nothing is worth nothing. */
    readonly intention: string;
    readonly origin: Origin;
    measure(): Promise<readonly Measurement[]>;
    judge(measurements: readonly Measurement[]): Judgement;
    /**
     * The same rule, one notch stricter — or `undefined` when it has no threshold to
     * tighten (a ban holds or it does not; it has no margin).
     *
     * This is rule mutation, the inverse of code mutation: coverage mutates the system,
     * vacuity mutates the specification. And it is free — `judge()` is pure over the
     * measurements, so the variant rejudges the same observations without running anything.
     *
     * Contract: the `judge()` of the returned rule must depend on its argument alone.
     */
    tighten?(): Rule | undefined;
};

type Outcome = {
    readonly rule: Rule;
    readonly measurements: readonly Measurement[];
    readonly magnitude: number;
    /** What was measured, in one sentence. */
    readonly detail: string;
};

/** The rule held. Nothing to report. */
export type Held = {
    readonly kind: 'held';
} & Outcome;

/**
 * A rule is violated although a human had ruled on it. That is a bug.
 *
 * Two origins: a rule written by hand, or an accepted gap whose threshold has just been
 * crossed — accepting is writing a rule.
 */
export type Infraction = {
    readonly kind: 'infraction';
} & Outcome;

/**
 * The rule held without ever being exercised. Green by absence, not by proof.
 *
 * This is not a violation — nothing proves the code is at fault. It is a green light worth
 * nothing, and keeping quiet about it would be exactly the lie speccov exists to avoid.
 */
export type Vacuous = {
    readonly kind: 'vacuous';
    readonly question: string;
} & Outcome;

/**
 * The rule holds, but with no margin at all: one notch stricter and it would fall.
 *
 * The observation sits exactly on the threshold. Either the code is at the limit and the
 * next item crosses it, or — more likely — the threshold was chosen *after* the observation,
 * to fit it. This is the "rule" version of "the test checks the constant against itself".
 */
export type Borderline = {
    readonly kind: 'borderline';
    readonly question: string;
} & Outcome;

/** No written rule frames this behaviour, and it does this. Open question. */
export type Lacuna = {
    readonly kind: 'lacuna';
    readonly question: string;
} & Outcome;

/** True when the verdict is about a rule that did not hold, whatever the severity. */
export function isBroken(verdict: Verdict): verdict is Infraction | Lacuna {
    return verdict.kind === 'infraction' || verdict.kind === 'lacuna';
}

export type Verdict = Held | Infraction | Lacuna | Vacuous | Borderline;

/**
 * Refuses a rule with no intention sentence. It is the only rule speccov applies to itself:
 * the field that makes the report readable cannot be optional.
 */
export function requireIntention(name: string, intention: string | undefined): string {
    const trimmed = intention?.trim() ?? '';
    if (trimmed === '') {
        throw new Error(`speccov: rule “${name}” has no intention. Write the sentence a human will read.`);
    }
    return trimmed;
}
