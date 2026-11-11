import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import ts from 'typescript';

export type LocalBuilder = {
    readonly name: string;
    /** A real call to this factory, taken from the spec: `buildUser('usr-a', 'org-demo')`. */
    readonly exampleCall: string | undefined;
    /** The return type as it is written, or `undefined` when it is implicit. */
    readonly returns: string | undefined;
    /** The whole declaration, ready to be copied into the draft. */
    readonly source: string;
};

/**
 * A `dep.method.mockResolvedValue({ items: [...], total: 1 })` taken from the spec.
 *
 * This is the shape the dependency has to return, written by someone who knows it. Copying it
 * avoids inventing it from the type — and above all avoids getting a key wrong.
 */
export type MockShape = {
    readonly property: string;
    readonly method: string;
    /** The name of the property carrying the array, e.g. `items`. */
    readonly arrayProperty: string;
    /** The first item of the array, as written: `buildUser('usr-a', 'org-demo')`. */
    readonly itemCall: string;
    /** The other properties, as written, ready to be copied. */
    readonly others: readonly { readonly name: string; readonly text: string; readonly wasCount: boolean }[];
};

export type MockBuilder = {
    readonly name: string;
    readonly from: string;
};

export type Harvest = {
    readonly specFile: string;
    /** Double factories imported by the sibling spec: the DI wiring, already written. */
    readonly mockBuilders: readonly MockBuilder[];
    /** Local functions of the spec, candidates as a command or item factory. */
    readonly helpers: readonly string[];
    /**
     * Those same functions, with their written return type and their source.
     *
     * The sibling spec declares its factories locally — `buildScopedQuery()` in a
     * real-world monorepo is not exported. It cannot be imported, so it is copied. And it is
     * only copied on a **return-type equality**, never on its name.
     */
    readonly localBuilders: readonly LocalBuilder[];
    /** The doubles the spec already feeds, by dependency and method. */
    readonly mocks: readonly MockShape[];
    /** Argument order taken from a `new <Class>(…)` in the spec. */
    readonly constructorArguments: readonly string[];
};

/**
 * Harvests the wiring already written in the sibling spec.
 *
 * The bridge is not generation: the doubles, the constructor order and the data factories
 * already exist. The job is to go and fetch them.
 */
export async function harvestSpec(sourceFile: string, className: string): Promise<Harvest | undefined> {
    const specFile = join(dirname(sourceFile), `${basename(sourceFile, '.ts')}.spec.ts`);
    let source: string;
    try {
        source = await readFile(specFile, 'utf8');
    } catch {
        return undefined;
    }
    return { specFile, ...readSpec(source, specFile, className) };
}

export function readSpec(source: string, specFile: string, className: string): Omit<Harvest, 'specFile'> {
    const parsed = ts.createSourceFile(specFile, source, ts.ScriptTarget.Latest, true);
    const mockBuilders: MockBuilder[] = [];
    const helpers: string[] = [];
    const localBuilders: LocalBuilder[] = [];
    const mocks: MockShape[] = [];
    let constructorArguments: readonly string[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const from = node.moduleSpecifier.text;
            const bindings = node.importClause?.namedBindings;
            if (bindings !== undefined && ts.isNamedImports(bindings)) {
                for (const element of bindings.elements) {
                    if (element.name.text.startsWith('buildMock')) {
                        mockBuilders.push({ name: element.name.text, from });
                    }
                }
            }
        }
        if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
            helpers.push(node.name.text);
            localBuilders.push({
                name: node.name.text,
                returns: node.type?.getText(parsed),
                source: node.getText(parsed),
                exampleCall: undefined,
            });
        }
        const mock = mockShape(node, parsed);
        if (mock !== undefined) {
            mocks.push(mock);
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === className) {
            constructorArguments = (node.arguments ?? []).map((argument) => argument.getText(parsed));
        }
        ts.forEachChild(node, visit);
    };

    visit(parsed);

    // Second pass: a real call to each factory. Copy the call rather than inventing
    // arguments — the spec already knows which values make the code run.
    const called = new Map<string, string>();
    const collect = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !called.has(node.expression.text)) {
            called.set(node.expression.text, node.getText(parsed));
        }
        ts.forEachChild(node, collect);
    };
    collect(parsed);

    return {
        mockBuilders,
        helpers,
        localBuilders: localBuilders.map((builder) => ({ ...builder, exampleCall: called.get(builder.name) })),
        mocks,
        constructorArguments,
    };
}

/** `users.list.mockResolvedValue({ items: [buildUser(…)], total: 1 })`, taken apart. */
function mockShape(node: ts.Node, parsed: ts.SourceFile): MockShape | undefined {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
        return undefined;
    }
    if (node.expression.name.text !== 'mockResolvedValue' && node.expression.name.text !== 'mockReturnValue') {
        return undefined;
    }
    const target = node.expression.expression;
    if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression)) {
        return undefined;
    }
    const [argument] = node.arguments;
    if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
        return undefined;
    }

    let arrayProperty: string | undefined;
    let itemCall: string | undefined;
    let count = 0;
    const others: { name: string; text: string; wasCount: boolean }[] = [];

    for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
            return undefined;
        }
        if (arrayProperty === undefined && ts.isArrayLiteralExpression(property.initializer)) {
            const [first] = property.initializer.elements;
            if (first === undefined) {
                return undefined;
            }
            arrayProperty = property.name.text;
            itemCall = first.getText(parsed);
            count = property.initializer.elements.length;
            continue;
        }
        others.push({
            name: property.name.text,
            text: property.initializer.getText(parsed),
            // A property that was exactly the number of items IS that number.
            // No other reading is made: `total: 3` over two items stays `3`.
            wasCount: ts.isNumericLiteral(property.initializer) && Number(property.initializer.text) === count,
        });
    }

    if (arrayProperty === undefined || itemCall === undefined) {
        return undefined;
    }
    return { property: target.expression.text, method: target.name.text, arrayProperty, itemCall, others };
}
