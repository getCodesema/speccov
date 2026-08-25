import ts from 'typescript';

export type ShapeKind = 'unbounded-fanout' | 'bounded-fanout' | 'async-per-item' | 'paginated-return';

export type Site = {
    readonly kind: ShapeKind;
    readonly file: string;
    readonly line: number;
    /** The code fragment involved, truncated so the report stays readable. */
    readonly excerpt: string;
};

const EXCERPT_LENGTH = 72;

/**
 * Spots the risky shapes by asking the types rather than guessing.
 *
 * The old pass recognised a read from the method name — `find*`, `get*`, `load*`. Measured on
 * the `apps/api` package of a real-world monorepo: 24 sites seen by type, 20 by name, and
 * **only 10 in common**. The name misses `update`, `addItem`, `republish`, `notifyRefreshChunk`
 * — one of them a write N+1 — and flags `getCompactDisplayName()`, which only reads memory.
 *
 * The return type decides without prejudice: a per-item operation that returns `Promise<…>`
 * leaves the process, whatever its name and whatever its meaning.
 */
export function findShapes(parsed: ts.SourceFile, checker: ts.TypeChecker, file: string): readonly Site[] {
    const scope = collectScope(parsed);
    const sites: Site[] = [];
    /** The `Promise.all` that fans out each `.map()`: both questions carry the same address. */
    const anchoredBy = new Map<ts.Node, ts.Node>();
    const seen = new Set<string>();

    const record = (kind: ShapeKind, node: ts.Node): void => {
        const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
        const key = `${kind}:${line}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        sites.push({ kind, file, line: line + 1, excerpt: excerpt(node.getText(parsed)) });
    };

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isPromiseAll(node)) {
            const [argument] = node.arguments;
            if (argument !== undefined) {
                record(isBoundedWidth(argument, scope) ? 'bounded-fanout' : 'unbounded-fanout', node);
                markFannedOut(argument, node, anchoredBy);
            }
        }
        if (ts.isCallExpression(node) && isMapCall(node) && callsAsyncPerItem(node, checker) && !isBoundedWidth(node, scope)) {
            record('async-per-item', anchoredBy.get(node) ?? node);
        }
        if (ts.isObjectLiteralExpression(node) && hasBoth(node, 'items', 'total')) {
            record('paginated-return', node);
        }
        ts.forEachChild(node, visit);
    };

    visit(parsed);
    return sites;
}

/**
 * The names whose width this file writes itself — the ones a `Promise.all(…)` can walk
 * without the ceiling question ever arising.
 *
 * A name enters through `isBoundedWidth`: `const TABLES = [a, b]`, `const batch = xs.slice(…)`,
 * `const pool = new Array(limit).fill(null).map(…)`. It leaves again if the file grows it.
 * It gets in all the same when it is **throttled** — a set on which the code waits for a
 * free slot.
 *
 * The order of the three passes is the order of caution: add, remove, then catch up. A
 * throttle beats growth because it is precisely what bounds it.
 *
 * The set is built in source order, so a chain follows through:
 * `const batch = xs.slice(i, i + n)` then `const tasks = batch.map(…)` classifies both. A
 * declaration read after its use is missed — a failure of caution, so it gets flagged.
 *
 * Limited to the current file: without `createProgram`, an imported constant stays opaque.
 * Same failure of caution — flag a bounded site rather than stay silent about one that is
 * not bounded.
 */
function collectScope(parsed: ts.SourceFile): Scope {
    const measured = collectMeasured(parsed);
    return { fixed: collectFixedCollections(parsed, measured), measured };
}

/** What the current file knows about the names it declares, and nothing more. */
type Scope = {
    /** The names whose width this file writes itself. */
    readonly fixed: ReadonlySet<string>;
    /** The names whose value this file computes from a collection size. */
    readonly measured: ReadonlySet<string>;
};

function collectFixedCollections(parsed: ts.SourceFile, measured: ReadonlySet<string>): ReadonlySet<string> {
    const names = new Set<string>();
    const declaredIn = new Map<string, Set<ts.Node>>();
    const mutations: (readonly [string, ts.Node])[] = [];
    const scope: Scope = { fixed: names, measured };
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
            const declaration = node.parent;
            const isConst = ts.isVariableDeclarationList(declaration) && (declaration.flags & ts.NodeFlags.Const) !== 0;
            if (isConst && isBoundedWidth(node.initializer, scope)) {
                names.add(node.name.text);
                const containers = declaredIn.get(node.name.text) ?? new Set<ts.Node>();
                containers.add(containerOf(node));
                declaredIn.set(node.name.text, containers);
            }
        }
        const grownName = growsInPlace(node);
        if (grownName !== undefined) {
            mutations.push([grownName, node]);
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    for (const [name, mutation] of mutations) {
        if (growsUnboundedly(mutation, declaredIn.get(name), scope)) {
            names.delete(name);
        }
    }
    for (const name of collectThrottled(parsed)) {
        names.add(name);
    }
    return names;
}

/** The function that carries this node, or the file when it sits at top level. */
function containerOf(node: ts.Node): ts.Node {
    let current: ts.Node | undefined = node;
    while (current !== undefined && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) {
        current = current.parent;
    }
    return current ?? node;
}

/**
 * Does this insertion grow the array **with the input**, or by a number written here?
 *
 * A `push` is not enough to decide, and counting it as growth without looking at what runs
 * it cost 10 sites across the five repos — `if (x) tasks.push(…)` three times in a row
 * (`package-manager.ts:1130` in pi), or `for (let i = 0; i < this.config.minConnections; i++)`
 * (`connection-pool.ts:136` in ruflo). Two shapes bounded in writing, flagged wrongly.
 *
 * What grows with the input, and nothing else:
 *
 * - a `for…of` / `for…in`: a collection is being iterated;
 * - a loop whose condition is not a comparison against a ceiling. `while (true)` is one such
 *   loop: the bound `true` is not a ceiling, it is the absence of one;
 * - a callback, that is, a function that does not carry the declaration: there is no telling
 *   how many times it runs.
 *
 * Everything else — straight line, loop with a capped condition — adds a number written in
 * the file, so the width stays written.
 */
function growsUnboundedly(mutation: ts.Node, declaredIn: ReadonlySet<ts.Node> | undefined, scope: Scope): boolean {
    if (declaredIn === undefined) {
        return true;
    }
    let current: ts.Node | undefined = mutation.parent;
    while (current !== undefined) {
        if (ts.isForOfStatement(current) || ts.isForInStatement(current)) {
            return true;
        }
        if (ts.isForStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current)) {
            const condition = ts.isForStatement(current) ? current.condition : current.expression;
            if (!isCappedComparison(condition, scope)) {
                return true;
            }
        }
        if (ts.isFunctionLike(current) || ts.isSourceFile(current)) {
            return !declaredIn.has(current);
        }
        current = current.parent;
    }
    return true;
}

/**
 * `i < this.config.minConnections` bounds the loop turn; `i < events.length` does not, and
 * `true` even less. The comparison is required, because `isCeiling` holds as a ceiling
 * everything it cannot read — useful on a length, wrong on a condition.
 */
function isCappedComparison(condition: ts.Expression | undefined, scope: Scope): boolean {
    return (
        condition !== undefined &&
        ts.isBinaryExpression(condition) &&
        COMPARISONS.has(condition.operatorToken.kind) &&
        isCeiling(condition, scope)
    );
}

const COMPARISONS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
]);

/**
 * Is the width of this expression written here, rather than read back off an input
 * collection? That is the question `resource()` asks, and an expression that answers it on
 * its own must not be flagged: that would penalise the fix.
 *
 * The recursion descends along the calls that cannot grow an array — `map`, `filter`,
 * `slice`, `fill`. `new Array(limit).fill(null).map(…)` is therefore bounded by `limit`,
 * exactly like the `Array.from({ length: limit }, …)` it rewrites: that is the worker pool,
 * measured on pi and prime-agent (`subagent/index.ts:228`).
 *
 * A spread hands the literal the width of what it spreads: `[...this.sessions.values()]` is
 * a whole collection under the syntax of a written array. 20 of the 22 literals in receiver
 * position found across the five repos were of that shape, and without this reservation the
 * widening would have silenced them all — measured, 51 sites of `resource()`.
 *
 * The spread of a width itself written stays written: `[a(), ...(op ? [op] : [])]` makes one
 * or two items, not a collection.
 */
function isBoundedWidth(node: ts.Expression, scope: Scope): boolean {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
        return isBoundedWidth(node.expression, scope);
    }
    if (ts.isArrayLiteralExpression(node)) {
        return node.elements.every((element) => !ts.isSpreadElement(element) || isBoundedWidth(element.expression, scope));
    }
    // `cond ? [x] : []` is worth zero or one item: both branches are written, so the width
    // is too. That is the optional argument of `agent-session.ts:8000` in prime-agent, and
    // demanding it unspread counted it as a whole collection.
    if (ts.isConditionalExpression(node)) {
        return isBoundedWidth(node.whenTrue, scope) && isBoundedWidth(node.whenFalse, scope);
    }
    if (ts.isIdentifier(node)) {
        return scope.fixed.has(node.text);
    }
    if (isDeclaredArity(node, scope) || isBoundedSlice(node, scope)) {
        return true;
    }
    if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        WIDTH_PRESERVING.has(node.expression.name.text)
    ) {
        return isBoundedWidth(node.expression.expression, scope);
    }
    return false;
}

/**
 * The array methods that never return more items than they receive.
 *
 * `flat` and `flatMap` are absent on purpose: they flatten, so they can multiply. `concat`
 * too.
 */
const WIDTH_PRESERVING = new Set(['map', 'filter', 'slice', 'fill']);

/**
 * The names throttled by a wait for a free slot: `await Promise.race(running)` when the batch
 * is full, and `running.delete(…)` as soon as a promise settles.
 *
 * That is the concurrency pool written without a library, and the final `Promise.all(running)`
 * drains only what is still in flight — at most the threshold, never the whole loop. It is
 * the very answer `resource()` demands: flagging it would penalise the fix.
 *
 * The three signals are required together. Awaiting `race` without ever removing frees no
 * slot; removing without awaiting slows nothing; and awaiting without looking at the size
 * waits exactly once, which caps nothing either. The threshold is the piece that bounds:
 * without it the rule would rest on an idiom, not on a reading. Real counter-example —
 * `rpc-mode.ts:535` in prime-agent adds and removes without ever awaiting, and stays flagged.
 */
function collectThrottled(parsed: ts.SourceFile): ReadonlySet<string> {
    const raced = new Set<string>();
    const drained = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const [only] = node.arguments;
            if (isPromiseRace(node) && only !== undefined && ts.isIdentifier(only) && guardsOnWidth(node, only.text)) {
                raced.add(only.text);
            }
            const removed = receiverOf(node, 'delete');
            if (removed !== undefined) {
                drained.add(removed);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    return new Set([...raced].filter((name) => drained.has(name)));
}

/**
 * The name of an array this file grows, or `undefined`.
 *
 * `const feedItems: AppItem[] = []` is a literal, but a `.push()` further down turns it into
 * an **accumulator**: its width is that of the loop filling it, not that of the literal.
 * Classing it bounded inverted the verdict — the N+1 of `resolve-app-items.ts:67` came out
 * filed under "proven by construction". Four sites in that monorepo hung on this.
 *
 * The removal applies to the name across the whole file, as the addition does: same failure
 * of caution, taken on the side that flags rather than the side that stays silent.
 */
function growsInPlace(node: ts.Node): string | undefined {
    if (!ts.isCallExpression(node)) {
        return undefined;
    }
    const pushed = receiverOf(node, 'push') ?? receiverOf(node, 'unshift');
    if (pushed !== undefined) {
        return pushed;
    }
    // `splice(start, count, ...items)` only inserts from the third argument on:
    // `xs.splice(0, 1)` removes, and an array that shrinks stays bounded by its declaration.
    return node.arguments.length >= 3 ? receiverOf(node, 'splice') : undefined;
}

/** The name of the receiver of `X.method(…)`, when X is an identifier. */
function receiverOf(node: ts.CallExpression, method: string): string | undefined {
    if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== method) {
        return undefined;
    }
    const receiver = node.expression.expression;
    return ts.isIdentifier(receiver) ? receiver.text : undefined;
}

/**
 * `xs.slice(start, end)` whose width is written, never read back off the collection.
 *
 * Two spellings cover batching as it is actually practised:
 * `slice(i, i + size)`, where the end is read from the start, and `slice(0, ceiling)`.
 * `slice(0, xs.length)` is not one, and `slice(1)` is not either: with no end, all of it stays.
 */
function isBoundedSlice(node: ts.Expression, scope: Scope): boolean {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'slice') {
        return false;
    }
    const [start, end] = node.arguments;
    if (start === undefined || end === undefined) {
        return false;
    }
    if (ts.isBinaryExpression(end) && end.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const from = start.getText();
        if (end.left.getText() === from) {
            return isCeiling(end.right, scope);
        }
        if (end.right.getText() === from) {
            return isCeiling(end.left, scope);
        }
        return false;
    }
    return ts.isNumericLiteral(start) && isCeiling(end, scope);
}

/**
 * Is this `Promise.race(X)` under a condition that reads the width of X?
 *
 * That is the wait for a slot: `if (running.size >= ceiling) await Promise.race(running)`.
 * The guard always sits immediately above the `race` in both measured sites
 * (`test-utils.ts:250` in ruflo, `runtime-local-skill-import-panel.tsx:781` in multica).
 */
function guardsOnWidth(node: ts.Node, name: string): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) {
        const condition = conditionOf(current);
        if (condition !== undefined && readsWidthOf(condition, name)) {
            return true;
        }
        current = current.parent;
    }
    return false;
}

function conditionOf(node: ts.Node): ts.Expression | undefined {
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        return node.expression;
    }
    return ts.isForStatement(node) ? node.condition : undefined;
}

function readsWidthOf(node: ts.Node, name: string): boolean {
    let found = false;
    const visit = (child: ts.Node): void => {
        if (found) {
            return;
        }
        if (
            ts.isPropertyAccessExpression(child) &&
            ts.isIdentifier(child.expression) &&
            child.expression.text === name &&
            (child.name.text === 'size' || child.name.text === 'length')
        ) {
            found = true;
            return;
        }
        ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
}

function isPromiseAll(node: ts.CallExpression): boolean {
    return isPromiseMethod(node, 'all') || isPromiseMethod(node, 'allSettled');
}

function isPromiseRace(node: ts.CallExpression): boolean {
    return isPromiseMethod(node, 'race');
}

function isPromiseMethod(node: ts.CallExpression, method: string): boolean {
    const callee = node.expression;
    return (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'Promise' &&
        callee.name.text === method
    );
}

function isMapCall(node: ts.CallExpression): boolean {
    return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map';
}

/**
 * Anchors to the `Promise.all` the `.map()` calls it fans out itself.
 *
 * `Promise.all(xs.map(f))` is **one** place, on which two rules each have their own
 * question: `resource()` asks for the concurrency ceiling, `complexity()` asks whether the
 * number of calls has to grow. Both stay open — but at the same address, that of the
 * `Promise.all`. Without this anchoring they landed one line apart from each other, and the
 * report announced two places where there is only one.
 *
 * The descent **stops at functions**. In `Promise.all(gs.map(async (g) => …))`, the outer
 * `.map` is anchored, but a `.map` written in the callback body fans out something else:
 * it keeps its own address.
 */
function markFannedOut(argument: ts.Expression, anchor: ts.Node, anchoredBy: Map<ts.Node, ts.Node>): void {
    const walk = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) {
            return;
        }
        if (ts.isCallExpression(node) && isMapCall(node)) {
            anchoredBy.set(node, anchor);
        }
        ts.forEachChild(node, walk);
    };
    walk(argument);
}

function hasBoth(node: ts.ObjectLiteralExpression, left: string, right: string): boolean {
    const names = new Set(
        node.properties.flatMap((property) =>
            property.name !== undefined && ts.isIdentifier(property.name) ? [property.name.text] : [],
        ),
    );
    return names.has(left) && names.has(right);
}

function excerpt(text: string): string {
    const single = text.replaceAll(/\s+/gu, ' ');
    return single.length <= EXCERPT_LENGTH ? single : `${single.slice(0, EXCERPT_LENGTH)}…`;
}

/**
 * An array whose length is written at the site: `Array.from({ length: N }, …)`,
 * `new Array(N)` and `Array(N)`. None of them spreads a collection — exactly N slots come
 * out, N written here. That is the worker-pool pattern, the very answer `resource()`
 * demands; flagging it would amount to penalising the fix.
 *
 * N still has to be a ceiling. `{ length: items.length }` and `new Array(items.length)`
 * only read the collection size back under another name, and stay unbounded.
 *
 * `Array.from(aCollection)` is not one either: without the `{ length }` literal, the length
 * comes from what is iterated. Measured on ruflo, six sites were of that shape.
 */
function isDeclaredArity(node: ts.Expression, scope: Scope): boolean {
    if (ts.isCallExpression(node) && node.expression.getText() === 'Array.from') {
        const [source] = node.arguments;
        if (source === undefined || !ts.isObjectLiteralExpression(source)) {
            return false;
        }
        const length = source.properties.find(
            (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) && property.name.getText() === 'length',
        );
        return length !== undefined && isCeiling(length.initializer, scope);
    }
    if (!ts.isNewExpression(node) && !ts.isCallExpression(node)) {
        return false;
    }
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'Array') {
        return false;
    }
    // A single argument, and it is the length. `Array(a, b)` is a list of items, and
    // `Array(...xs)` spreads one: neither of them writes a ceiling here.
    const [size, ...rest] = node.arguments ?? [];
    return size !== undefined && rest.length === 0 && !ts.isSpreadElement(size) && isCeiling(size, scope);
}

/**
 * A ceiling is an expression that no collection size makes grow.
 *
 * The reading is structural, because the top node alone lies: `Math.floor(keys.length * f)`
 * is not a neutral call, it is `keys.length` in disguise. Real site — `sw.ts:367` in that
 * monorepo, where the purged share of the cache grows with the cache. Without this descent,
 * widening the sliced batch to the receiver silenced it.
 *
 * - `Math.min(a, b)`: a single capped term is enough, the minimum exceeds neither of them;
 * - `Math.max(a, b)`: all of them are needed, the maximum exceeds each. That is what keeps
 *   `Math.max(1, Math.min(concurrency, items.length))` — the ceiling of pi's pool;
 * - a rounding, a parenthesis, an operation: descend, and both sides are required;
 * - `X.length`, `X.size`, and a name this file computes from either of the two: never.
 *
 * Everything else — literal, call, other property — is held to be a ceiling. The failure of
 * caution flips here, and that is deliberate: `giveMeTheLimit()` is unreadable without
 * running it, and refusing to conclude would flag every pool, that is, every fix.
 */
function isCeiling(expression: ts.Expression, scope: Scope): boolean {
    if (ts.isParenthesizedExpression(expression)) {
        return isCeiling(expression.expression, scope);
    }
    if (ts.isCallExpression(expression)) {
        const callee = expression.expression.getText();
        if (callee === 'Math.min') {
            return expression.arguments.some((argument) => isCeiling(argument, scope));
        }
        if (callee === 'Math.max' || ROUNDING.has(callee)) {
            return expression.arguments.every((argument) => isCeiling(argument, scope));
        }
        return true;
    }
    if (ts.isBinaryExpression(expression)) {
        // Subtracting can only reduce: `target - alreadyDone` never exceeds `target`, even
        // when what is subtracted is a size. `container-worker-pool.ts:283` in ruflo writes
        // exactly that, and requiring both sides flagged two sites wrongly. The reverse does
        // not hold: `pooledAgents.size - target` grows with the pool, and the left-hand side
        // says so — `agent-pool.ts:222`, which stays flagged.
        if (expression.operatorToken.kind === ts.SyntaxKind.MinusToken) {
            return isCeiling(expression.left, scope);
        }
        return isCeiling(expression.left, scope) && isCeiling(expression.right, scope);
    }
    if (ts.isPropertyAccessExpression(expression)) {
        return expression.name.text !== 'length' && expression.name.text !== 'size';
    }
    if (ts.isIdentifier(expression)) {
        return !scope.measured.has(expression.text);
    }
    return true;
}

/** The roundings, which do not change the magnitude of what they receive. */
const ROUNDING = new Set(['Math.floor', 'Math.ceil', 'Math.round', 'Math.trunc', 'Math.abs']);

/**
 * The names whose value this file computes from a collection size.
 *
 * `const toPurge = Math.floor(keys.length * fraction)` carries the name of a ceiling and is
 * not one: `keys.slice(0, toPurge)` grows with the cache. The name alone says nothing, only
 * its initialisation decides.
 *
 * The fixed point catches chains — `const n = xs.length` then `const m = n * 2`. The set can
 * only grow over a finite file: the loop terminates.
 */
function collectMeasured(parsed: ts.SourceFile): ReadonlySet<string> {
    const initializers: (readonly [string, ts.Expression])[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
            initializers.push([node.name.text, node.initializer]);
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);

    const measured = new Set<string>();
    const scope: Scope = { fixed: new Set(), measured };
    let growing = true;
    while (growing) {
        growing = false;
        for (const [name, initializer] of initializers) {
            if (!measured.has(name) && !isCeiling(initializer, scope)) {
                measured.add(name);
                growing = true;
            }
        }
    }
    return measured;
}

/**
 * Does the `.map()` callback contain a call whose return type is a promise, fired once per
 * item?
 *
 * Neither a name, nor an `await`, nor a surrounding `Promise.all` is assumed: in TypeScript,
 * what leaves the process returns a promise, and `async` propagates on its own up to every
 * caller. Measured on that monorepo, no surface-synchronous `.map()` hid I/O further down —
 * one level of type is enough.
 *
 * Two bounds, and they close the same error on either side of the dot.
 *
 * Downstream: the descent stops at the edge of the first function nested in the callback.
 * A call written in an `onClick` is not fired by the `.map()`: it is fired later, if the
 * user clicks. Without this bound, every list render whose rows carry a handler becomes a
 * fan-out — 17 of the 37 sites found on multica, 18 of the 46 on hermes-agent, all of it
 * JSX without a single `await`.
 *
 * Upstream: the receiver is not visited. In `(await listDir(root)).map((e) => e.path)`, the
 * promise is the receiver's — one call, once, then a synchronous `.map()`. Counting it would
 * amount to penalising the batched read, that is, the very answer that `complexity()`
 * demands. 18 of the 28 remaining sites in pi hung on this.
 */
function callsAsyncPerItem(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
    let found = false;
    const visit = (child: ts.Node, deferred: boolean): void => {
        if (found) {
            return;
        }
        if (ts.isCallExpression(child) && child !== call && returnsPromise(child, checker)) {
            found = true;
            return;
        }
        if (ts.isFunctionLike(child)) {
            if (deferred) {
                return;
            }
            ts.forEachChild(child, (grandchild) => visit(grandchild, true));
            return;
        }
        ts.forEachChild(child, (grandchild) => visit(grandchild, deferred));
    };

    // The arguments alone: the receiver is set aside, and we are already inside the callback.
    for (const argument of call.arguments) {
        if (ts.isFunctionLike(argument)) {
            ts.forEachChild(argument, (child) => visit(child, true));
        } else {
            visit(argument, true);
        }
    }
    return found;
}

function returnsPromise(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
    const signature = checker.getResolvedSignature(call);
    if (signature === undefined) {
        return false;
    }
    const returned = checker.getReturnTypeOfSignature(signature);
    return checker.typeToString(returned).startsWith('Promise<');
}
