import { basename, dirname, join } from 'node:path';
import type { DraftSite, Parameter, Probe, Subject } from './extract';
import type { Harvest } from './harvest';

export type Draft = {
    /** Where to write the draft: next to the use case, like its spec. */
    readonly path: string;
    readonly content: string;
    /** The decisions left to a human. While one of them remains, the measurement is worth nothing. */
    readonly todos: readonly string[];
};

/**
 * A ceiling is not derived, and neither is the reason that set it. Letting both throw at module
 * load is deliberate: `resource()` validates its ceiling at construction, so an unfinished draft
 * cannot even load — there is no window in which it would measure green by accident.
 */
const CEILING_STUB = `
/** TODO speccov: choose the tolerated concurrency peak. */
function ceiling(): number {
    throw new Error('TODO speccov: choose the tolerated concurrency peak.');
}

/**
 * TODO speccov: say **where this ceiling comes from**, never paraphrase it.
 *
 * This is the sentence the agent reads when the rule breaks. "Peak never exceeds 4" teaches it
 * nothing: it cannot tell whether 4 is sacred or arbitrary, so it may "fix" the failure by
 * raising the threshold. The reason — where the number comes from — tells it the fix is to cap
 * the call.
 */
function intention(): string {
    throw new Error('TODO speccov: say where this ceiling comes from.');
}
`;

/**
 * Wrap rather than replace: the only way to measure a method of the subject itself.
 *
 * A double would return an invented value there, and the rest of the code would measure that
 * invention. Here the real method is still called: the probe only adds a count around it,
 * and what is observed stays the real code.
 */
export const AROUND_HELPER = `
/** Wraps the real method: the probe counts without changing what the code does. */
function around(target: object, method: string, wrap: (call: () => unknown) => unknown): void {
    const holder = target as unknown as Record<string, (...args: readonly unknown[]) => unknown>;
    const original = holder[method];
    if (typeof original !== 'function') {
        throw new Error(\`TODO speccov: \${method}() is not found on the subject.\`);
    }
    const bound = original.bind(target);
    holder[method] = (...args: readonly unknown[]) => wrap(() => bound(...args));
}
`;

/**
 * The double of a parameter: it knows how to do one thing, carry the probe.
 *
 * That is what makes the type assertion honest. It does not pretend to *be* the
 * dependency: it refuses everything it is not, and names itself doing so. No invented
 * value and no silent `undefined` therefore reaches the measured code — the draft
 * stops before that, saying which member is missing.
 */
export const ONLY_HELPER = `
/** A single-member double: everything else throws, so nothing invented enters the code. */
function only<T>(name: string, method?: string, probe?: (...args: readonly unknown[]) => unknown): T {
    return new Proxy({} as Record<PropertyKey, unknown>, {
        get: (_target, property) => {
            if (method !== undefined && property === method) {
                return probe;
            }
            // A symbol is a language protocol, not a call from the measured code.
            if (typeof property === 'symbol') {
                return undefined;
            }
            const doubled = method === undefined ? \`no member of \${name} is doubled\` : \`only \${name}.\${method}() carries the probe\`;
            throw new Error(\`TODO speccov: \${name}.\${String(property)}() is not doubled — \${doubled}.\`);
        },
    }) as T;
}
`;

/** The names the draft writes itself: a parameter of the same name would take their place. */
const RESERVED = new Set([
    'size',
    'items',
    'subject',
    'gauge',
    'counter',
    'missing',
    'around',
    'collectionOf',
    'ceiling',
    'intention',
    'command',
]);

/**
 * Writes the draft rule.
 *
 * Two guarantees hold everything up: what is derivable is in place, and **what is not
 * throws at runtime**. An unfinished draft fails loudly, never silently — a subject that
 * "works" while measuring the wrong thing would be worse than no subject at all.
 */
export function renderDraft(site: DraftSite, harvest: Harvest | undefined): Draft {
    const todos: string[] = [];
    const builders = harvest?.mockBuilders ?? [];
    const fanout = site.shape === 'unbounded-fanout';
    const { subject, probe } = site;

    const helpers = harvest?.helpers ?? [];
    const hint = helpers.length > 0 ? ` The neighbouring spec exposes: ${helpers.join(', ')}.` : '';

    const wiring =
        subject.kind === 'class'
            ? wireConstructor(subject, builders, probe, fanout, todos)
            : { lines: [] as string[], used: [] as string[], args: '', mocked: false, usesOnly: false };
    const known = new Map(wiring.used.map((name) => [name, builders.find((builder) => builder.name === name)?.from ?? '']));

    const imports = [
        fanout
            ? "import { resource, Gauge } from '@codesema/speccov';"
            : "import { complexity, Counter } from '@codesema/speccov';",
        ...[...known].sort().map(([name, from]) => `import { ${name} } from '${from}';`),
        `import { ${subject.kind === 'class' ? subject.className : subject.functionName} } from './${basename(site.file, '.ts')}';`,
    ];

    if (fanout) {
        // A ceiling is a decision, never a derivation: `resource()` is `origin: 'declared'`
        // for that reason. Letting it throw is refusing to guess it.
        todos.push('choose the tolerated concurrency peak.');
        // A ceiling without its reason is a bare number: the agent reading the failure cannot
        // tell a grounded bound from an arbitrary threshold, and raises the threshold.
        todos.push('say where this ceiling comes from.');
    }

    const collection = renderCollection(site, harvest, probe, fanout, hint, todos);
    const entry = renderEntryArguments(site, harvest, todos, hint);
    const invocation =
        subject.kind === 'class'
            ? `            await subject.${subject.methodName}(${entry.args.join(', ')});`
            : `            await ${subject.functionName}(${entry.args.join(', ')});`;

    const content = `/**
 * Draft produced by \`speccov draft\`.
 *
 * Site: ${site.file}:${site.line}
 *       \`${site.collection}.map(…)\` calls \`${describe(probe)}\` per item.
 *
 * What was derivable is in place. What needed a decision throws at runtime:
 * an unfinished draft fails loudly, it never produces a misleading green light.
 */
${imports.join('\n')}

${fanout ? 'const gauge = new Gauge();' : 'const counter = new Counter();'}
${fanout ? CEILING_STUB : ''}
${collection.block}

${entry.blocks.join('\n\n')}

function missing(what: string): never {
    throw new Error(\`TODO speccov: \${what}\`);
}
${probe.kind === 'own' ? AROUND_HELPER : ''}${probe.kind === 'parameter' || wiring.usesOnly ? ONLY_HELPER : ''}
export default [
    ${fanout ? 'resource' : 'complexity'}({
        name: '${label(subject)} · ${fanout ? 'concurrency' : 'reads'} via ${short(probe)}',
        unit: '${fanout ? 'concurrent reads' : 'reads'}',
${fanout ? '        ceiling: ceiling(),\n        intention: intention(),\n        gauge,' : '        counter,'}
        subject: async (size) => {
${[...wiring.lines, ...instantiate(subject, wiring.args), ...probeLines(probe, subject, fanout, wiring.mocked, todos), ...collection.feeding].join('\n')}

${invocation}
        },
    }),
];
`;

    // Absent blocks leave their blank line behind them: a draft gets read, and three blank
    // lines tell of a hole that does not exist.
    return {
        path: join(dirname(site.file), `${basename(site.file, '.ts')}.rules.ts`),
        content: content.replace(/\n{3,}/gu, '\n\n'),
        todos,
    };
}

/**
 * The constructor doubles.
 *
 * A factory harvested from the neighbouring spec returns a runner mock, and that is the only
 * thing that allows a `.mockImplementation()` further down. Without a factory there is no
 * mock: writing `missing(…)` threw on the very first line — the subject could not even be
 * instantiated, and the rest of the draft was dead code that did not compile. The `only()`
 * double does exist, and throws only on the member actually asked for.
 */
function wireConstructor(
    subject: Extract<Subject, { kind: 'class' }>,
    builders: Harvest['mockBuilders'],
    probe: Probe,
    fanout: boolean,
    todos: string[],
): { lines: string[]; used: string[]; args: string; mocked: boolean; usesOnly: boolean } {
    const used: string[] = [];
    let mocked = false;
    let usesOnly = false;
    const lines = subject.constructorParameters.flatMap(({ name, type }, index) => {
        if (name === '') {
            todos.push(`provide argument ${index + 1} of the ${subject.className} constructor`);
            return [];
        }
        const builder = builders.find(({ name: candidate }) => matches(candidate, type));
        if (builder !== undefined) {
            used.push(builder.name);
            mocked ||= probe.kind === 'injected' && probe.property === name;
            return [`            const ${name} = ${builder.name}();`];
        }

        usesOnly = true;
        const wanted = `ConstructorParameters<typeof ${subject.className}>[${index}]`;
        if (probe.kind === 'injected' && probe.property === name) {
            // The probe goes into the double: it is the "provide a double" decision that
            // disappears, not the one about the returned value. That one stays written below.
            todos.push(valueTodo(name, probe.method));
            return [
                `            // No factory harvested: the double carries the probe and refuses everything else.`,
                `            const ${name} = only<${wanted}>('${name}', '${probe.method}', () =>`,
                `                ${wrapValue(fanout, `missing('value returned by ${name}.${probe.method}()')`)},`,
                `            );`,
            ];
        }
        // The hole is marked in the text like all the others: whoever fills it must be able to
        // find in the file every line the list announces, and the other way round.
        todos.push(`provide a double for "${name}: ${type}"`);
        return [
            `            // TODO speccov: provide a double for "${name}: ${type}" — no member is doubled.`,
            `            const ${name} = only<${wanted}>('${name}');`,
        ];
    });
    const args = subject.constructorParameters
        .map(({ name }, index) => (name === '' ? `missing('constructor argument ${index + 1}')` : name))
        .join(', ');
    return { lines, used, args, mocked, usesOnly };
}

function instantiate(subject: Subject, args: string): string[] {
    if (subject.kind !== 'class') {
        return [];
    }
    // A class without a constructor instantiates with nothing: requiring injection ruled out
    // half of the real classes for a constraint the code does not impose.
    return [`            const subject = new ${subject.className}(${args});`, ''];
}

/**
 * Placing the probe, and this is where the carrier decides everything.
 *
 * An injected dependency gets replaced — the value it returned becomes a hole. A method of
 * the subject gets wrapped, and nothing is invented. A parameter receives a double that
 * carries **only** the probed member: any other call breaks, so an incomplete draft cannot
 * measure green by accident. The iterated item has nothing to place here: the probe is
 * already in the collection the draft builds.
 */
function probeLines(probe: Probe, subject: Subject, fanout: boolean, mocked: boolean, todos: string[]): string[] {
    const wrap = (inner: string): string => wrapValue(fanout, inner);

    if (probe.kind === 'injected') {
        // Without a harvested factory, the double is not a runner mock: `.mockImplementation`
        // would not exist on it. The probe has then already been placed at wiring, in `only()`.
        if (!mocked) {
            return [];
        }
        todos.push(valueTodo(probe.property, probe.method));
        return [
            `            // Derived from the scan: this is the call found in the .map(). The probe ${fanout ? 'wraps' : 'counts'} without`,
            `            // deciding the returned value — it is up to the TODO above to provide it.`,
            `            ${probe.property}.${probe.method}.mockImplementation(async () =>`,
            `                ${wrap(`missing('value returned by ${probe.property}.${probe.method}()')`)},`,
            `            );`,
            '',
        ];
    }
    if (probe.kind === 'own') {
        return [
            `            // Derived from the scan: this is the call the .map() returns. The probe wraps the`,
            `            // real method, it does not replace it — what is measured stays the real code.`,
            fanout
                ? `            around(subject, '${probe.method}', (call) => gauge.track(async () => call()));`
                : `            around(subject, '${probe.method}', (call) => {\n                counter.hit();\n                return call();\n            });`,
            '',
        ];
    }
    if (probe.kind === 'parameter') {
        const index = subject.entryParameters.findIndex(({ name }) => name === probe.parameter);
        const type = index === -1 ? 'unknown' : `Parameters<${signature(subject)}>[${index}]`;
        todos.push(valueTodo(probe.parameter, probe.method));
        return [
            `            // The double carries only the probed member: any other access throws, naming itself.`,
            `            // An incomplete draft therefore cannot measure green by accident.`,
            `            const ${probe.parameter} = only<${type}>('${probe.parameter}', '${probe.method}', () =>`,
            `                ${wrap(`missing('value returned by ${probe.parameter}.${probe.method}()')`)},`,
            `            );`,
            '',
        ];
    }
    return [];
}

/**
 * The collection: first trace it back, then feed it where it is born.
 *
 * Three origins, three wirings, and a single case with no answer — the one where tracing
 * back did not succeed. It stays written out in full rather than filled in by guesswork:
 * a size that does not reach the subject makes the measurement flat, and the rule lies.
 */
function renderCollection(
    site: DraftSite,
    harvest: Harvest | undefined,
    probe: Probe,
    fanout: boolean,
    hint: string,
    todos: string[],
): { block: string; feeding: string[] } {
    // A probe carried by the item forces its own factory: the spec's would count nothing.
    if (probe.kind === 'item') {
        todos.push(`provide the value each item returns from ${probe.method}().`);
        const inner = fanout
            ? `gauge.track(async () => missing('value returned by item.${probe.method}()'))`
            : `{\n            counter.hit();\n            return missing('value returned by item.${probe.method}()');\n        }`;
        const block = `/** The probe is carried by the item: the collection is ours, the only safe place for it. */
function collectionOf(size: number) {
    return Array.from({ length: size }, () => ({
        ${probe.method}: () => ${inner},
    }));
}`;
        return { block, feeding: feed(site, harvest, todos) };
    }

    const origin = site.origin;
    const mock = (harvest?.mocks ?? []).find(
        (candidate) =>
            origin !== undefined &&
            origin.kind === 'dependency' &&
            candidate.property === origin.property &&
            candidate.method === origin.method &&
            candidate.arrayProperty === origin.path[0],
    );
    if (mock === undefined) {
        const collectionTodo = `build a collection of \`size\` items.${hint}`;
        todos.push(collectionTodo);
        // When the collection is an argument of the entry point, its type is written in the
        // signature. Leaving it as `unknown[]` forced fixing the hole *and* its type.
        const returns = origin?.kind === 'argument' ? `Parameters<${signature(site.subject)}>[${origin.index}]` : 'unknown[]';
        const block = `/** TODO speccov: ${collectionTodo} */
function collectionOf(size: number): ${returns} {
    throw new Error(\`TODO speccov: build a collection of \${size} items.\`);
}`;
        return { block, feeding: feed(site, harvest, todos) };
    }

    const itemBuilder = (harvest?.localBuilders ?? []).find(({ name }) => mock.itemCall.startsWith(`${name}(`));
    const block = `${itemBuilder === undefined ? '' : `/** Copied from ${basename(harvest?.specFile ?? '', '.ts')}: the factory the spec already feeds. */\n${itemBuilder.source}\n\n`}/** The same item repeated: the size varies, the content does not — the measurement depends on it alone. */
function collectionOf(size: number) {
    return Array.from({ length: size }, () => ${mock.itemCall});
}`;
    return { block, feeding: feed(site, harvest, todos, mock) };
}

/** Where the items enter the measured code. */
function feed(site: DraftSite, harvest: Harvest | undefined, todos: string[], mock?: Harvest['mocks'][number]): string[] {
    const origin = site.origin;
    const items = '            const items = collectionOf(size);';

    if (origin?.kind === 'argument') {
        // The safest case: the collection is an argument of the entry point, so it is the
        // draft that passes it. Nothing to double, nothing to trace back.
        return [
            `            // "${origin.name}" is argument ${origin.index + 1} of the entry point: the size enters there directly.`,
            items,
            '',
        ];
    }
    if (origin?.kind === 'dependency' && mock !== undefined) {
        const rebuilt = [
            `${mock.arrayProperty}: items`,
            ...mock.others.map(({ name, text, wasCount }) => `${name}: ${wasCount ? 'items.length' : text}`),
        ].join(', ');
        return [
            `            // Traced back from the site to ${origin.property}.${origin.method}(): that is where the collection comes from.`,
            items,
            `            ${origin.property}.${origin.method}.mockResolvedValue({ ${rebuilt} });`,
            '',
        ];
    }
    todos.push('wire this collection onto the dependency that produces it.');
    void harvest;
    return [
        items,
        `            missing(\`wire these \${items.length} items onto the dependency that produces the collection\`);`,
        '',
    ];
}

/**
 * The entry point arguments, one by one.
 *
 * Each has a derived role — the collection, the probed double — or stays a hole. A hole
 * is a function that throws, and its type comes from the signature: the compiler will say
 * what to provide, better than a sentence would.
 */
function renderEntryArguments(
    site: DraftSite,
    harvest: Harvest | undefined,
    todos: string[],
    hint: string,
): { args: string[]; blocks: string[] } {
    const { subject, probe, origin } = site;
    const args: string[] = [];
    const blocks: string[] = [];
    const taken = new Set(RESERVED);

    subject.entryParameters.forEach((parameter, index) => {
        if (origin?.kind === 'argument' && origin.index === index) {
            args.push('items');
            return;
        }
        if (probe.kind === 'parameter' && parameter.name === probe.parameter) {
            args.push(probe.parameter);
            return;
        }
        const name = stubName(subject, parameter, index, taken);
        taken.add(name);
        const wanted = `Parameters<${signature(subject)}>[${index}]`;
        const copied = (harvest?.localBuilders ?? []).find(({ returns }) => returns === wanted);
        if (copied === undefined) {
            const what = `provide ${describeArgument(subject, parameter, index)}.${hint}`;
            todos.push(what);
            blocks.push(`/** TODO speccov: ${what} */
function ${name}(): ${wanted} {
    throw new Error('TODO speccov: provide ${describeArgument(subject, parameter, index)}.');
}`);
        } else {
            // The factory is **copied** from the neighbouring spec, and only when its return
            // type is written and equal to the hole's. The name decides nothing: two
            // factories can share a name and return something else.
            blocks.push(`/** Copied from ${basename(harvest?.specFile ?? '', '.ts')}: same return type, verbatim. */
${copied.source.replace(copied.name, name)}`);
        }
        args.push(`${name}()`);
    });

    return { args, blocks };
}

function describeArgument(subject: Subject, parameter: Parameter, index: number): string {
    const target = subject.kind === 'class' ? `${subject.className}.${subject.methodName}()` : `${subject.functionName}()`;
    return parameter.name === ''
        ? `argument ${index + 1} of ${target}`
        : subject.entryParameters.length === 1
          ? `a valid command for ${target}`
          : `a value for "${parameter.name}: ${parameter.type}" of ${target}`;
}

function stubName(subject: Subject, parameter: Parameter, index: number, taken: ReadonlySet<string>): string {
    if (subject.entryParameters.length === 1) {
        return 'command';
    }
    return parameter.name !== '' && !taken.has(parameter.name) ? `${parameter.name}Argument` : `argument${index + 1}`;
}

/**
 * The decision no probe replaces: what the counted call must return.
 *
 * Placing the probe does not say which value it returns, and the measured code consumes that
 * value. The decision list is the contract with whoever fills it — often an agent: a hole the
 * list keeps quiet about becomes an unannounced `throw`, so a loop, or worse a `missing()`
 * deleted to "repair" things. Hence the invariant: one `missing(…)` written, one line.
 */
function valueTodo(carrier: string, method: string): string {
    return `provide the value ${carrier}.${method}() must return.`;
}

/** Wrap a value the same way everywhere: the probe does not change with the place. */
function wrapValue(fanout: boolean, inner: string): string {
    return fanout
        ? `gauge.track(async () => ${inner})`
        : `(() => {\n                    counter.hit();\n                    return ${inner};\n                })()`;
}

function signature(subject: Subject): string {
    return subject.kind === 'class' ? `${subject.className}['${subject.methodName}']` : `typeof ${subject.functionName}`;
}

function label(subject: Subject): string {
    return subject.kind === 'class' ? `${subject.className}.${subject.methodName}` : subject.functionName;
}

function short(probe: Probe): string {
    switch (probe.kind) {
        case 'injected':
            return `${probe.property}.${probe.method}`;
        case 'parameter':
            return `${probe.parameter}.${probe.method}`;
        case 'item':
            return `item.${probe.method}`;
        default:
            return probe.method;
    }
}

function describe(probe: Probe): string {
    switch (probe.kind) {
        case 'injected':
            return `this.${probe.property}.${probe.method}()`;
        case 'parameter':
            return `${probe.parameter}.${probe.method}()`;
        case 'item':
            return `item.${probe.method}()`;
        default:
            return `this.${probe.method}()`;
    }
}

/** `buildMockOrganizations` covers `OrganizationRepositoryPort`: we compare the roots. */
function matches(builderName: string, type: string): boolean {
    const root = builderName.replace(/^buildMock/u, '').toLowerCase();
    const target = type.replace(/(RepositoryPort|Port|Service)$/u, '').toLowerCase();
    return root.startsWith(target) || target.startsWith(root);
}
