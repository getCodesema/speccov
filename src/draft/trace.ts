import ts from 'typescript';

/**
 * Where the iterated collection comes from.
 *
 * Two origins, and one thing really tells them apart: the one the draft can **feed**. An
 * injected dependency is driven through its double; a parameter of the entry point is driven
 * more simply still — we are the ones passing it.
 */
export type CollectionOrigin =
    | {
          readonly kind: 'dependency';
          /** The injected dependency that produces the collection, e.g. `users`. */
          readonly property: string;
          /** The method called on it, e.g. `list`. */
          readonly method: string;
          /** The path read on its result, e.g. `['items']`. Empty when the collection is returned as is. */
          readonly path: readonly string[];
      }
    | {
          /** The collection is an argument of the entry point: the draft passes it itself. */
          readonly kind: 'argument';
          readonly index: number;
          readonly name: string;
      };

export type TraceScope = {
    /** What contains the site: the class, or the file when the function is free-standing. */
    readonly container: ts.ClassDeclaration | ts.SourceFile;
    /** What the draft calls. Its parameters are under our direct control. */
    readonly entry: ts.SignatureDeclarationBase;
    readonly owned: ReadonlySet<string>;
    readonly parsed: ts.SourceFile;
};

/**
 * The calls that do not change **where the collection comes from**.
 *
 * `concat` and `flat` are excluded, for a reason different from the one that keeps them out of
 * the width computation in `shapes.ts`: here they have **two origins**, not one.
 * `a.concat(b)` would trace back to `a` and say nothing of `b`; the draft would then feed only
 * one of the two sources and measure a fan-out over a half-empty collection — a green light
 * obtained on the wrong thing. Two origins is a refusal, never a choice.
 *
 * `sort` and `reverse` stay: they reorder a single source, they do not add to it.
 */
const PASS_THROUGH = new Set(['filter', 'map', 'slice', 'sort', 'reverse']);

/** Safety bound: a round trip between two methods must not loop forever. */
const MAX_HOPS = 24;

/**
 * Traces the iterated collection back to what produces it.
 *
 * The site says *who* is called per item; it does not say *where the items come from*.
 * Without this trace, the draft does not know what to feed, and the size never reaches the
 * subject — the measurement is then flat and the rule lies.
 *
 * Every hop is a local declaration, a call argument or a property access: AST reading, never a
 * guess. What cannot be traced back returns `undefined`, and the hole stays written in the
 * draft.
 */
export function traceCollection(collection: ts.Expression, scope: TraceScope): CollectionOrigin | undefined {
    const path: string[] = [];
    let current: ts.Expression | undefined = collection;

    for (let hop = 0; hop < MAX_HOPS && current !== undefined; hop += 1) {
        const node: ts.Expression = current;

        if (
            ts.isAwaitExpression(node) ||
            ts.isParenthesizedExpression(node) ||
            ts.isNonNullExpression(node) ||
            ts.isAsExpression(node)
        ) {
            current = node.expression;
            continue;
        }

        // `this.users.list(…)`: the source, if `users` really is an injected dependency.
        const source = injectedCall(node, scope.owned);
        if (source !== undefined) {
            return { kind: 'dependency', ...source, path: [...path].reverse() };
        }

        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            PASS_THROUGH.has(node.expression.name.text)
        ) {
            current = node.expression.expression;
            continue;
        }

        // `page.items`: note the property and carry on with `page`.
        if (ts.isPropertyAccessExpression(node)) {
            path.push(node.name.text);
            current = node.expression;
            continue;
        }

        if (ts.isIdentifier(node)) {
            // A parameter of the entry point is the safest origin there is: the draft has
            // nothing to double, it passes the collection itself. We require it returned as is —
            // rebuilding a carrier object would invent its other fields.
            const index = parameterIndex(scope.entry, node.text);
            if (index !== -1 && path.length === 0 && enclosingCallable(node) === scope.entry) {
                return { kind: 'argument', index, name: node.text };
            }
            current = boundTo(node, scope);
            continue;
        }

        return undefined;
    }
    return undefined;
}

/** `this.<dependency>.<method>(…)`, when the dependency comes from the constructor. */
function injectedCall(node: ts.Expression, owned: ReadonlySet<string>): { property: string; method: string } | undefined {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
        return undefined;
    }
    const target = node.expression.expression;
    if (!ts.isPropertyAccessExpression(target) || target.expression.kind !== ts.SyntaxKind.ThisKeyword) {
        return undefined;
    }
    const property = target.name.text;
    return owned.has(property) ? { property, method: node.expression.name.text } : undefined;
}

function parameterIndex(callable: ts.SignatureDeclarationBase, name: string): number {
    return callable.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name);
}

/**
 * What an identifier is bound to: the initialiser of its `const`, or — when it is a parameter —
 * the argument passed at the single call to its method.
 *
 * "Single" is not a detail. Two callers pass two different collections; picking one would amount
 * to measuring one path while believing another is measured.
 */
function boundTo(name: ts.Identifier, scope: TraceScope): ts.Expression | undefined {
    const callable = enclosingCallable(name);
    if (callable === undefined) {
        return undefined;
    }

    const local = localDeclaration(callable, name.text);
    if (local !== undefined) {
        return local;
    }

    const index = parameterIndex(callable, name.text);
    const owner = ts.isMethodDeclaration(callable) || ts.isFunctionDeclaration(callable) ? callable.name : undefined;
    if (index === -1 || owner === undefined) {
        return undefined;
    }
    const calls = callsTo(scope.container, owner.getText(scope.parsed), scope.parsed);
    return calls.length === 1 ? calls[0]?.arguments[index] : undefined;
}

function localDeclaration(callable: ts.SignatureDeclarationBase, name: string): ts.Expression | undefined {
    let found: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
        if (
            found === undefined &&
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name &&
            node.initializer !== undefined
        ) {
            found = node.initializer;
            return;
        }
        ts.forEachChild(node, visit);
    };
    const { body } = callable as ts.SignatureDeclarationBase & { body?: ts.Node };
    if (body !== undefined) {
        visit(body);
    }
    return found;
}

/** Every call to `<name>` in the container: `this.<name>(…)` or `<name>(…)`. */
function callsTo(container: ts.ClassDeclaration | ts.SourceFile, name: string, parsed: ts.SourceFile): ts.CallExpression[] {
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const onThis =
                ts.isPropertyAccessExpression(callee) &&
                callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
                callee.name.getText(parsed) === name;
            if (onThis || (ts.isIdentifier(callee) && callee.text === name)) {
                calls.push(node);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(container);
    return calls;
}

function enclosingCallable(node: ts.Node): ts.SignatureDeclarationBase | undefined {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
        if (
            ts.isMethodDeclaration(current) ||
            ts.isFunctionDeclaration(current) ||
            ts.isArrowFunction(current) ||
            ts.isFunctionExpression(current)
        ) {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}
