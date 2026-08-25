import ts from 'typescript';

export type Mutant = {
    /** Stable identifier: same mutated code ⇒ same identifier, from one run to the next. */
    readonly id: string;
    readonly file: string;
    readonly line: number;
    readonly mutator: string;
    readonly start: number;
    readonly end: number;
    readonly original: string;
    readonly replacement: string;
};

/**
 * The alteration operators, reimplemented on the TypeScript AST.
 *
 * The catalogue comes from the state of the art in mutation testing (Stryker, PIT): these are
 * the alterations that empirically reveal the most verification holes. We reimplement it rather
 * than depend on Stryker, so that the scope and the budget stay ours to choose.
 */
const BINARY_SWAPS = new Map<ts.SyntaxKind, string>([
    [ts.SyntaxKind.GreaterThanToken, '>='],
    [ts.SyntaxKind.GreaterThanEqualsToken, '>'],
    [ts.SyntaxKind.LessThanToken, '<='],
    [ts.SyntaxKind.LessThanEqualsToken, '<'],
    [ts.SyntaxKind.EqualsEqualsEqualsToken, '!=='],
    [ts.SyntaxKind.ExclamationEqualsEqualsToken, '==='],
    [ts.SyntaxKind.EqualsEqualsToken, '!='],
    [ts.SyntaxKind.ExclamationEqualsToken, '=='],
    [ts.SyntaxKind.AmpersandAmpersandToken, '||'],
    [ts.SyntaxKind.BarBarToken, '&&'],
    [ts.SyntaxKind.QuestionQuestionToken, '||'],
    [ts.SyntaxKind.PlusToken, '-'],
    [ts.SyntaxKind.MinusToken, '+'],
    [ts.SyntaxKind.AsteriskToken, '/'],
    [ts.SyntaxKind.SlashToken, '*'],
    [ts.SyntaxKind.PercentToken, '*'],
]);

const MUTATOR_OF = new Map<ts.SyntaxKind, string>([
    [ts.SyntaxKind.GreaterThanToken, 'comparison'],
    [ts.SyntaxKind.GreaterThanEqualsToken, 'comparison'],
    [ts.SyntaxKind.LessThanToken, 'comparison'],
    [ts.SyntaxKind.LessThanEqualsToken, 'comparison'],
    [ts.SyntaxKind.EqualsEqualsEqualsToken, 'equality'],
    [ts.SyntaxKind.ExclamationEqualsEqualsToken, 'equality'],
    [ts.SyntaxKind.EqualsEqualsToken, 'equality'],
    [ts.SyntaxKind.ExclamationEqualsToken, 'equality'],
    [ts.SyntaxKind.AmpersandAmpersandToken, 'logic'],
    [ts.SyntaxKind.BarBarToken, 'logic'],
    [ts.SyntaxKind.QuestionQuestionToken, 'logic'],
]);

export function findMutants(file: string, source: string): readonly Mutant[] {
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const mutants: Mutant[] = [];

    const add = (
        node: ts.Node,
        replacement: string,
        mutator: string,
        start = node.getStart(parsed),
        end = node.getEnd(),
    ): void => {
        const { line } = parsed.getLineAndCharacterOfPosition(start);
        const original = source.slice(start, end);
        if (original === replacement) {
            return;
        }
        mutants.push({
            id: `${file}:${start}:${mutator}`,
            file,
            line: line + 1,
            mutator,
            start,
            end,
            original,
            replacement,
        });
    };

    const visit = (node: ts.Node): void => {
        if (isErased(node)) {
            return;
        }
        if (ts.isBinaryExpression(node)) {
            const swap = BINARY_SWAPS.get(node.operatorToken.kind);
            if (swap !== undefined) {
                const token = node.operatorToken;
                add(token, swap, MUTATOR_OF.get(token.kind) ?? 'arithmetic', token.getStart(parsed), token.getEnd());
            }
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword) {
            add(node, 'false', 'boolean');
        }
        if (node.kind === ts.SyntaxKind.FalseKeyword) {
            add(node, 'true', 'boolean');
        }
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
            add(node, node.operand.getText(parsed), 'negation');
        }
        if (ts.isArrayLiteralExpression(node) && node.elements.length > 0) {
            add(node, '[]', 'array emptied');
        }
        if (ts.isStringLiteral(node) && node.text !== '') {
            add(node, '""', 'string emptied');
        }
        if (isOptionalChain(node)) {
            add(
                node.questionDotToken,
                '.',
                'optional chaining',
                node.questionDotToken.getStart(parsed),
                node.questionDotToken.getEnd(),
            );
        }
        if (isEmptiableBody(node, parsed)) {
            add(node, '{}', 'body emptied');
        }
        ts.forEachChild(node, visit);
    };

    visit(parsed);
    return mutants;
}

function isOptionalChain(node: ts.Node): node is ts.PropertyAccessExpression & { questionDotToken: ts.QuestionDotToken } {
    return ts.isPropertyAccessExpression(node) && node.questionDotToken !== undefined;
}

/** Emptying a non-empty function body: the most brutal alteration, and so the most revealing. */
function isEmptiableBody(node: ts.Node, parsed: ts.SourceFile): node is ts.Block {
    if (!ts.isBlock(node) || node.statements.length === 0) {
        return false;
    }
    const parent = node.parent;
    const isFunctionBody =
        ts.isFunctionDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isFunctionExpression(parent);
    return isFunctionBody && node.getText(parsed) !== '{}';
}

/** Applies a mutant to the source text. Pure: touches no file. */
export function applyMutant(source: string, mutant: Mutant): string {
    return source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
}

/**
 * What the compiler erases before execution: types, interfaces, aliases, type imports.
 * Placing a mutant there yields a guaranteed survivor — the compiled code is identical,
 * no test can object.
 *
 * These false survivors are not neutral: they drown the real ones in the report, and a
 * report nobody can sort through is no longer a report anyone decides from.
 */
function isErased(node: ts.Node): boolean {
    return (
        ts.isTypeNode(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true)
    );
}
