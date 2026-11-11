import ts from 'typescript';

export function returnsPromise(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
    const signature = checker.getResolvedSignature(call);
    if (signature === undefined) {
        return false;
    }
    const returned = checker.getReturnTypeOfSignature(signature);
    return checker.typeToString(returned).startsWith('Promise<');
}

/**
 * Does this parameter leave the function through a call that returns a promise?
 *
 * "Exported" was the only definition of a frontier, and in a codebase of ES modules
 * everything is exported: measured on a real monorepo, the question was asked 744 times, six
 * times more than the four others together. A value that reaches an asynchronous call goes
 * somewhere the compiler does not follow, a query, a request, a file. A value that only feeds
 * a computation stays where the types still hold.
 *
 * One hop, and no more: the parameter is read inside the arguments of the call, never traced
 * through a variable or a helper. So this can only take sites away, never invent one. And
 * where there is nothing to read, a declaration without a body, the question stays.
 */
export function reachesAsyncCall(
    parameter: ts.ParameterDeclaration,
    body: ts.Node | undefined,
    checker: ts.TypeChecker,
): boolean {
    const symbol = checker.getSymbolAtLocation(parameter.name);
    if (body === undefined || symbol === undefined) {
        return true;
    }
    let reached = false;
    const visit = (node: ts.Node): void => {
        if (reached) {
            return;
        }
        if (
            ts.isCallExpression(node) &&
            returnsPromise(node, checker) &&
            node.arguments.some((argument) => mentions(argument, symbol, checker))
        ) {
            reached = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(body);
    return reached;
}

function mentions(node: ts.Node, symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
    if (ts.isIdentifier(node) && symbolOf(node, checker) === symbol) {
        return true;
    }
    return ts.forEachChild(node, (child) => mentions(child, symbol, checker)) ?? false;
}

/** In `{ id }` the identifier names the property: the value it carries is asked for separately. */
function symbolOf(identifier: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
    return ts.isShorthandPropertyAssignment(identifier.parent)
        ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : checker.getSymbolAtLocation(identifier);
}
