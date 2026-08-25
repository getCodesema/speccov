import ts from 'typescript';
import { traceCollection, type CollectionOrigin } from './trace';

export type Parameter = {
    /** Empty when the parameter is destructured: it has no name to write. */
    readonly name: string;
    readonly type: string;
};

/**
 * What the draft calls to reach the site.
 *
 * A class with injected dependencies is just one of the shapes TypeScript takes. An exported
 * function receives its dependencies as parameters: there is nothing to instantiate, and the
 * subject calls it directly. Telling the two apart here spares the rendering from assuming.
 */
export type Subject =
    | {
          readonly kind: 'class';
          readonly className: string;
          readonly methodName: string;
          readonly constructorParameters: readonly Parameter[];
          readonly entryParameters: readonly Parameter[];
      }
    | {
          readonly kind: 'function';
          readonly functionName: string;
          readonly entryParameters: readonly Parameter[];
      };

/**
 * What is counted per item, and above all **who carries it**.
 *
 * The carrier decides how to observe, and each way costs a different amount of honesty:
 * an injected dependency is swapped for a double, an own method is **wrapped** without
 * being replaced, an item of the collection is built by the draft itself.
 */
export type Probe =
    | { readonly kind: 'injected'; readonly property: string; readonly method: string }
    | { readonly kind: 'own'; readonly method: string }
    | { readonly kind: 'item'; readonly method: string }
    | { readonly kind: 'parameter'; readonly parameter: string; readonly method: string };

export type DraftSite = {
    readonly file: string;
    readonly line: number;
    readonly subject: Subject;
    readonly probe: Probe;
    /** The expression being iterated, e.g. `candidatesWithOrganization`. */
    readonly collection: string;
    /** Where that collection comes from, when tracing back lands. */
    readonly origin: CollectionOrigin | undefined;
    /**
     * What the site calls, and therefore the rule to write. A `.map()` wrapped in a
     * `Promise.all` fires everything at once: the question is the ceiling, not the total —
     * so `resource()` and its `Gauge`. A bare `.map()` calls in series: that is `complexity()`.
     */
    readonly shape: 'unbounded-fanout' | 'async-per-item';
};

/**
 * A refusal is not a failure: it is the expected behavior when several reads share the same
 * `.map()`. Guessing which one to count would produce a subject that measures the wrong
 * thing — a reassuring green light that lies, exactly what this fights.
 */
export type Extraction =
    { readonly kind: 'drafted'; readonly site: DraftSite } | { readonly kind: 'refused'; readonly reason: string };

const READ_VERBS = /^(find|get|load|fetch|read|list|search|count|exists)/u;

export function extractSite(file: string, source: string, line: number): Extraction {
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const call = findMapCallAt(parsed, line);
    if (call === undefined) {
        return { kind: 'refused', reason: `no ".map(…)" call at line ${line} of ${file}.` };
    }

    const found = enclosingCallable(call);
    if (found === undefined) {
        return { kind: 'refused', reason: 'the site is not inside a function or a method: nothing to call from the outside.' };
    }

    const resolved =
        found.class === undefined ? freeSubject(found.callable, parsed) : classSubject(found.callable, found.class, parsed);
    if (resolved.kind === 'refused') {
        return resolved;
    }
    const { subject, entry } = resolved;

    const owned = new Set(subject.kind === 'class' ? subject.constructorParameters.map(({ name }) => name) : []);
    const probe = chooseProbe(call, owned, found.callable);
    if (probe.kind === 'refused') {
        return probe;
    }

    const container = found.class ?? parsed;
    return {
        kind: 'drafted',
        site: {
            file,
            line,
            subject,
            probe: probe.probe,
            collection: collectionOf(call, parsed),
            origin: ts.isPropertyAccessExpression(call.expression)
                ? traceCollection(call.expression.expression, { container, entry, owned, parsed })
                : undefined,
            shape: awaitedTogether(call) ? 'unbounded-fanout' : 'async-per-item',
        },
    };
}

type Resolved =
    | { readonly kind: 'found'; readonly subject: Subject; readonly entry: ts.SignatureDeclarationBase }
    | { readonly kind: 'refused'; readonly reason: string };

/**
 * The subject when the site lives inside a class.
 *
 * An empty constructor is no obstacle: `new C()` is enough, and requiring injection has so
 * far ruled out half of the real classes for a reason that did not exist.
 */
function classSubject(callable: ts.SignatureDeclarationBase, declaration: ts.ClassDeclaration, parsed: ts.SourceFile): Resolved {
    if (declaration.name === undefined) {
        return { kind: 'refused', reason: 'the class is anonymous: nothing to instantiate from the draft.' };
    }
    if (!ts.isMethodDeclaration(callable)) {
        return { kind: 'refused', reason: 'the site is not inside a class method: nothing to instantiate.' };
    }
    const entry = publicEntryFor(callable, declaration, parsed);
    if (entry.kind === 'refused') {
        return entry;
    }
    return {
        kind: 'found',
        subject: {
            kind: 'class',
            className: declaration.name.text,
            methodName: entry.name,
            constructorParameters: readConstructorParameters(declaration, parsed),
            entryParameters: readParameters(entry.method.parameters, parsed),
        },
        entry: entry.method,
    };
}

/**
 * The subject when the site lives inside a free function.
 *
 * Only an exported function lets itself be called from a neighboring rules file. A function
 * local to the module is out of scope: naming it would mean writing an import that does not
 * compile.
 */
function freeSubject(callable: ts.SignatureDeclarationBase, parsed: ts.SourceFile): Resolved {
    const named = exportedName(callable);
    if (named === undefined) {
        return { kind: 'refused', reason: 'the site is not inside an exported function: nothing to call from the outside.' };
    }
    return {
        kind: 'found',
        subject: { kind: 'function', functionName: named, entryParameters: readParameters(callable.parameters, parsed) },
        entry: callable,
    };
}

/** `export function f()` and `export const f = () => …`: both forms can be imported. */
function exportedName(callable: ts.SignatureDeclarationBase): string | undefined {
    if (ts.isFunctionDeclaration(callable)) {
        const exported = (ts.getCombinedModifierFlags(callable) & ts.ModifierFlags.Export) !== 0;
        return exported && callable.name !== undefined ? callable.name.text : undefined;
    }
    const parent = callable.parent;
    if (
        (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable)) &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name)
    ) {
        return (ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Export) !== 0 ? parent.name.text : undefined;
    }
    return undefined;
}

type Chosen = { readonly kind: 'found'; readonly probe: Probe } | { readonly kind: 'refused'; readonly reason: string };

/**
 * What to count per item.
 *
 * Two readings, in this order. First the injected dependencies read in the body: that is the
 * case where a double already exists, so the most measurable — and two of them stay an
 * ambiguity we refuse. Then, failing that, **the call the callback returns**: in a
 * `Promise.all(xs.map(x => f(x)))`, that is exactly what goes out in parallel. This is not a
 * naming heuristic, it is the structure of the site.
 */
function chooseProbe(call: ts.CallExpression, owned: ReadonlySet<string>, callable: ts.SignatureDeclarationBase): Chosen {
    const reads = collectReads(call, owned);
    if (reads.length > 1) {
        const listed = reads.map(({ property, method }) => `this.${property}.${method}()`).join(', ');
        return {
            kind: 'refused',
            reason: `several reads in this .map() (${listed}). Tell me which one to count, I will not guess.`,
        };
    }
    const [read] = reads;
    if (read !== undefined) {
        return { kind: 'found', probe: { kind: 'injected', ...read } };
    }

    const perItem = perItemCall(call);
    if (perItem === undefined) {
        return {
            kind: 'refused',
            reason: 'the .map() callback does not point to a single call per item: nothing identifiable to count.',
        };
    }
    return classify(perItem, call, owned, callable);
}

function classify(
    returned: ts.CallExpression,
    call: ts.CallExpression,
    owned: ReadonlySet<string>,
    callable: ts.SignatureDeclarationBase,
): Chosen {
    const callee = returned.expression;
    if (!ts.isPropertyAccessExpression(callee)) {
        return {
            kind: 'refused',
            reason: 'the call returned per item is a module function: it cannot be observed without a module double.',
        };
    }
    const method = callee.name.text;
    const target = callee.expression;

    if (target.kind === ts.SyntaxKind.ThisKeyword) {
        return { kind: 'found', probe: { kind: 'own', method } };
    }
    if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
        if (owned.has(target.name.text)) {
            return { kind: 'found', probe: { kind: 'injected', property: target.name.text, method } };
        }
        return {
            kind: 'refused',
            reason: `the call returned per item goes through "this.${target.name.text}", which is not injected: nothing to observe without rewriting internal state.`,
        };
    }
    if (!ts.isIdentifier(target)) {
        return {
            kind: 'refused',
            reason: 'the call returned per item starts from an expression, not from a name: the probe carrier cannot be identified.',
        };
    }
    if (itemNames(call).has(target.text)) {
        return { kind: 'found', probe: { kind: 'item', method } };
    }
    if (parameterNames(callable).has(target.text)) {
        return { kind: 'found', probe: { kind: 'parameter', parameter: target.text, method } };
    }
    return {
        kind: 'refused',
        reason: `"${target.text}" is neither a parameter nor the item being iterated: the draft cannot replace it with a probe.`,
    };
}

/**
 * The call the `.map()` fires per item.
 *
 * Two readings, from the sharpest to the broadest. **What the callback returns** first: in
 * `xs.map((x) => f(x))`, that is exactly what the `Promise.all` spreads out. Then, failing
 * that, **the sole awaited call of the body**: a callback that guards on entry then `await`s
 * once — the most widespread shape in real code — also has only one piece of work per item,
 * and it is that `await` that holds the slot for the whole fan-out.
 *
 * Beyond a single one, we stop. Picking one call out of the batch would measure a cog while
 * believing it measures the fan-out.
 */
function perItemCall(call: ts.CallExpression): ts.CallExpression | undefined {
    const callback = callbackOf(call);
    if (callback === undefined) {
        return undefined;
    }
    const { body } = callback;
    if (!ts.isBlock(body)) {
        return asCall(body);
    }
    const returns = body.statements.filter(ts.isReturnStatement);
    const [returned] = returns;
    if (returns.length === 1 && returned?.expression !== undefined) {
        const found = asCall(returned.expression);
        if (found !== undefined) {
            return found;
        }
    }
    return soleAwaitedCall(body);
}

/**
 * The sole `await`ed call of the body, when there is only one.
 *
 * The `await`s of a nested callback do not count: they belong to a spread other than the
 * site's, and conflating them would place the probe one notch too low.
 */
function soleAwaitedCall(body: ts.Block): ts.CallExpression | undefined {
    const awaited: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
            return;
        }
        if (ts.isAwaitExpression(node)) {
            const found = asCall(node.expression);
            if (found !== undefined) {
                awaited.push(found);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(body);
    const [only] = awaited;
    return awaited.length === 1 ? only : undefined;
}

function callbackOf(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
    const [callback] = call.arguments;
    return callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback : undefined;
}

function asCall(expression: ts.Expression): ts.CallExpression | undefined {
    let current: ts.Expression = expression;
    while (
        ts.isAwaitExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isNonNullExpression(current)
    ) {
        current = current.expression;
    }
    return ts.isCallExpression(current) ? current : undefined;
}

/** The names the callback binds to the item, destructuring included. */
function itemNames(call: ts.CallExpression): ReadonlySet<string> {
    const names = new Set<string>();
    const callback = callbackOf(call);
    if (callback === undefined) {
        return names;
    }
    const [first] = callback.parameters;
    if (first !== undefined) {
        bindingNames(first.name, names);
    }
    return names;
}

function parameterNames(callable: ts.SignatureDeclarationBase): ReadonlySet<string> {
    const names = new Set<string>();
    for (const parameter of callable.parameters) {
        bindingNames(parameter.name, names);
    }
    return names;
}

function bindingNames(name: ts.BindingName, into: Set<string>): void {
    if (ts.isIdentifier(name)) {
        into.add(name.text);
        return;
    }
    for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
            bindingNames(element.name, into);
        }
    }
}

type Entry =
    | { readonly kind: 'found'; readonly name: string; readonly method: ts.MethodDeclaration }
    | { readonly kind: 'refused'; readonly reason: string };

/**
 * The entry point to call from the draft.
 *
 * A private method cannot be called from the outside, and measuring an internal cog rather
 * than the use case would skew the subject. So we walk up to the public method that calls
 * it — and if there are zero or several of them, we refuse instead of choosing.
 */
function publicEntryFor(method: ts.MethodDeclaration, declaration: ts.ClassDeclaration, parsed: ts.SourceFile): Entry {
    const name = methodNameOf(method, parsed);
    if (!isPrivate(method)) {
        return { kind: 'found', name, method };
    }
    const callers = declaration.members
        .filter(ts.isMethodDeclaration)
        .filter((candidate) => !isPrivate(candidate) && callsMethod(candidate, name));

    const [only] = callers;
    if (callers.length === 1 && only !== undefined) {
        return { kind: 'found', name: methodNameOf(only, parsed), method: only };
    }
    if (callers.length === 0) {
        return {
            kind: 'refused',
            reason: `"${name}" is private and no public method calls it: nothing to measure from the outside.`,
        };
    }
    return {
        kind: 'refused',
        reason: `"${name}" is private and ${callers.length} public methods call it (${callers
            .map((candidate) => methodNameOf(candidate, parsed))
            .join(', ')}). Tell me the entry point, I will not guess.`,
    };
}

function isPrivate(method: ts.MethodDeclaration): boolean {
    return (ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Private) !== 0;
}

function callsMethod(method: ts.MethodDeclaration, name: string): boolean {
    let found = false;
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
            node.expression.name.text === name
        ) {
            found = true;
        }
        ts.forEachChild(node, visit);
    };
    if (method.body !== undefined) {
        visit(method.body);
    }
    return found;
}

/**
 * Is the `.map()` the argument of a `Promise.all` / `Promise.allSettled`?
 *
 * We walk up through parentheses and `as`, nothing else: `Promise.all(await f(xs.map(…)))`
 * does not spread the `.map()` itself, and counting it as such would produce a ceiling
 * measured on the wrong thing.
 */
function awaitedTogether(call: ts.CallExpression): boolean {
    let current: ts.Node = call;
    let parent: ts.Node | undefined = call.parent;
    while (parent !== undefined && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) {
        current = parent;
        parent = parent.parent;
    }
    if (parent !== undefined && ts.isSpreadElement(parent)) {
        current = parent;
        parent = parent.parent;
    }
    if (parent !== undefined && ts.isArrayLiteralExpression(parent)) {
        current = parent;
        parent = parent.parent;
    }
    if (parent === undefined || !ts.isCallExpression(parent) || !parent.arguments.includes(current as ts.Expression)) {
        return false;
    }
    const callee = parent.expression;
    return (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'Promise' &&
        (callee.name.text === 'all' || callee.name.text === 'allSettled')
    );
}

function findMapCallAt(parsed: ts.SourceFile, line: number): ts.CallExpression | undefined {
    let found: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') {
            const { line: at } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
            // A call folded over several lines: we accept the Promise.all line just above.
            if (at + 1 === line || at === line) {
                found ??= node;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    return found;
}

/**
 * The function or method that contains the site, and the class that carries it.
 *
 * The anonymous callbacks crossed along the way are not entry points: we keep walking up to
 * what has a name, the only thing an import can name.
 */
function enclosingCallable(
    node: ts.Node,
): { readonly callable: ts.SignatureDeclarationBase; readonly class: ts.ClassDeclaration | undefined } | undefined {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
        if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) {
            return { callable: current, class: ts.isClassDeclaration(current.parent) ? current.parent : undefined };
        }
        if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && exportedName(current) !== undefined) {
            return { callable: current, class: undefined };
        }
        current = current.parent;
    }
    return undefined;
}

function readConstructorParameters(declaration: ts.ClassDeclaration, parsed: ts.SourceFile): readonly Parameter[] {
    const found = declaration.members.find(ts.isConstructorDeclaration);
    return readParameters(found?.parameters ?? [], parsed);
}

/** Position counts as much as the name: a destructured parameter keeps its slot, without a name. */
function readParameters(parameters: readonly ts.ParameterDeclaration[], parsed: ts.SourceFile): readonly Parameter[] {
    return parameters.map((parameter) => ({
        name: ts.isIdentifier(parameter.name) ? parameter.name.text : '',
        type: parameter.type?.getText(parsed) ?? 'unknown',
    }));
}

type Read = {
    readonly property: string;
    readonly method: string;
};

/** The `this.<dependency>.<readVerb>(…)` calls in the body of the `.map()`. */
function collectReads(call: ts.CallExpression, owned: ReadonlySet<string>): readonly Read[] {
    const reads = new Map<string, Read>();
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const target = node.expression.expression;
            if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
                const property = target.name.text;
                const method = node.expression.name.text;
                if (owned.has(property) && READ_VERBS.test(method)) {
                    reads.set(`${property}.${method}`, { property, method });
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    call.arguments.forEach((argument) => visit(argument));
    return [...reads.values()];
}

function collectionOf(call: ts.CallExpression, parsed: ts.SourceFile): string {
    return ts.isPropertyAccessExpression(call.expression) ? call.expression.expression.getText(parsed) : 'collection';
}

function methodNameOf(method: ts.MethodDeclaration, parsed: ts.SourceFile): string {
    return method.name.getText(parsed);
}
