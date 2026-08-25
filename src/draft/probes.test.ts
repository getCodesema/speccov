import { describe, expect, test } from 'bun:test';
import { Gauge } from '../gauge';
import type { DraftSite } from './extract';
import { AROUND_HELPER, ONLY_HELPER, renderDraft } from './render';

/**
 * The probes travel inside the draft as text: reading them back proves nothing. They are
 * transpiled and executed, because the guarantee they carry — "an incomplete draft throws" —
 * is a runtime guarantee, not a reading one.
 */
function load<T>(source: string, name: string): T {
    const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
    return new Function(`${javascript}\nreturn ${name};`)() as T;
}

type Only = <T>(name: string, method: string, probe: (...args: readonly unknown[]) => unknown) => T;
type Around = (target: object, method: string, wrap: (call: () => unknown) => unknown) => void;

describe('the double of a parameter', () => {
    const only = load<Only>(ONLY_HELPER, 'only');

    test('the probed member is the only one that answers', () => {
        const screens = only<{ fetchState: () => string }>('screens', 'fetchState', () => 'probed');
        expect(screens.fetchState()).toBe('probed');
    });

    test('any other member throws, naming what is missing', () => {
        const screens = only<Record<string, () => unknown>>('screens', 'fetchState', () => undefined);
        // The question that decides everything: a member with no double cannot return
        // `undefined` silently, or the measured code would carry on with a false value.
        expect(() => screens['describe']).toThrow(/screens\.describe\(\) is not doubled/u);
    });

    test('a language protocol is not a call from the measured code', () => {
        const screens = only<object>('screens', 'fetchState', () => undefined);
        expect(() => Object.prototype.toString.call(screens)).not.toThrow();
    });
});

describe('the probe set on a method of the subject', () => {
    const around = load<Around>(AROUND_HELPER, 'around');

    test('the real method is still called: nothing is replaced', () => {
        const seen: string[] = [];
        const subject = {
            work(id: string): string {
                seen.push(id);
                return `done ${id}`;
            },
        };
        around(subject, 'work', (call) => call());
        expect(subject.work('a')).toBe('done a');
        expect(seen).toEqual(['a']);
    });

    test('the wrapping sees every call the code emits', () => {
        let counted = 0;
        const subject = { work: (): number => 1 };
        around(subject, 'work', (call) => {
            counted += 1;
            return call();
        });
        subject.work();
        subject.work();
        expect(counted).toBe(2);
    });

    test('a missing method throws rather than measuring nothing', () => {
        expect(() => around({}, 'work', (call) => call())).toThrow(/work\(\) is not found/u);
    });
});

/**
 * Executes a whole draft.
 *
 * The imports are replaced by hand-supplied bindings: what runs is still the text `draft`
 * wrote, only the outside module is simulated. Reading that text back would prove nothing —
 * the defect being targeted is a runtime defect.
 */
function execute(content: string, bindings: Record<string, unknown>): unknown {
    const stripped = content
        .split('\n')
        .filter((line) => !line.startsWith('import '))
        .join('\n')
        .replace('export default', 'const rules =');
    const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(stripped);
    const names = Object.keys(bindings);
    return new Function(...names, `${javascript}\nreturn rules;`)(...names.map((name) => bindings[name]));
}

/** What a human would do with the TODOs: fill them, one by one, where they are named. */
function fill(content: string): string {
    return content
        .replace("throw new Error('TODO speccov: choose the tolerated concurrency peak.');", 'return 8;')
        .replace(
            "throw new Error('TODO speccov: say where this ceiling comes from.');",
            "return 'the pool holds 10 connections';",
        )
        .replace(
            'throw new Error(`TODO speccov: build a collection of ${size} items.`);',
            'return Array.from({ length: size }, (_, index) => ({ id: String(index) }));',
        )
        .replace("missing('value returned by screens.fetchState()')", "Promise.resolve({ id: 'read' })");
}

const NO_FACTORY: DraftSite = {
    file: '/repo/sync-screens.ts',
    line: 14,
    subject: {
        kind: 'class',
        className: 'SyncScreens',
        methodName: 'run',
        constructorParameters: [{ name: 'screens', type: 'ScreenPort' }],
        entryParameters: [{ name: 'all', type: 'readonly Screen[]' }],
    },
    probe: { kind: 'injected', property: 'screens', method: 'fetchState' },
    collection: 'all',
    origin: { kind: 'argument', index: 0, name: 'all' },
    shape: 'unbounded-fanout',
};

class SyncScreens {
    constructor(private readonly screens: { fetchState(id: string): Promise<unknown> }) {}

    async run(all: readonly { readonly id: string }[]): Promise<unknown[]> {
        return Promise.all(all.map((screen) => this.screens.fetchState(screen.id)));
    }
}

type FakeRule = {
    readonly gauge: { readonly peak: number };
    readonly subject: (size: number) => Promise<void>;
};

function loadRule(content: string, klass: unknown = SyncScreens): FakeRule {
    const rules = execute(content, {
        Gauge,
        resource: (options: FakeRule) => options,
        SyncScreens: klass,
    }) as readonly FakeRule[];
    const [rule] = rules;
    if (rule === undefined) {
        throw new Error('the draft produced no rule');
    }
    return rule;
}

describe('a draft with no harvested factory', () => {
    test('the wiring no longer dies on the first line', async () => {
        // Before: `const screens = missing(…)` threw at wiring time, and everything else was
        // dead code. The only hole that must stop execution is the collection one.
        const rule = loadRule(
            renderDraft(NO_FACTORY, undefined)
                .content.replace("throw new Error('TODO speccov: choose the tolerated concurrency peak.');", 'return 8;')
                .replace(
                    "throw new Error('TODO speccov: say where this ceiling comes from.');",
                    "return 'the pool holds 10 connections';",
                ),
        );
        expect(rule.subject(2)).rejects.toThrow(/build a collection/u);
    });

    test('the probe counts the real fan-out once the holes are filled', async () => {
        const rule = loadRule(fill(renderDraft(NO_FACTORY, undefined).content));
        await rule.subject(4);
        expect(rule.gauge.peak).toBe(4);
    });

    test('a member the double does not carry throws, naming itself', async () => {
        // The measured code calls a second member, which nothing doubles. The draft must stop
        // and name it, rather than measure a green light obtained on `undefined`.
        class OtherUsage {
            constructor(private readonly screens: { describe(id: string): string }) {}

            async run(all: readonly { readonly id: string }[]): Promise<unknown[]> {
                return all.map((screen) => this.screens.describe(screen.id));
            }
        }
        const rule = loadRule(fill(renderDraft(NO_FACTORY, undefined).content), OtherUsage);
        expect(rule.subject(1)).rejects.toThrow(/screens\.describe\(\) is not doubled/u);
    });
});
