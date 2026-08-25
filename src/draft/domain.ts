import ts from 'typescript';

export type DomainField = {
    readonly name: string;
    /** The values, already rendered as TypeScript source. */
    readonly values: readonly string[];
    /** The declared type, as it is written. Used in the message when a value is needed. */
    readonly declared: string;
    /** False when part of the type is infinite: a `string`, a `number`, an object. */
    readonly finite: boolean;
};

export type DomainRead =
    | { readonly kind: 'read'; readonly typeName: string; readonly fields: readonly DomainField[] }
    | { readonly kind: 'refused'; readonly reason: string };

/**
 * Reads the domain of a type, field by field.
 *
 * A union type is finite and can be written out: `'viewer' | 'org_admin'` makes two cases,
 * `X | null` makes two as well. That is where the automation lives — not at run time, where
 * the type is gone, but when writing the draft, where the compiler is there.
 *
 * What is not finite is **written anyway**, as a call that throws. A `string` has no
 * interesting value the type knows about: "an area" and "no area" is a business
 * distinction. We leave it to a human, by naming it.
 */
export function readDomain(file: string, typeName: string): DomainRead {
    const program = ts.createProgram([file], {
        target: ts.ScriptTarget.Latest,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
    });
    const source = program.getSourceFile(file);
    if (source === undefined) {
        return { kind: 'refused', reason: `${file} could not be read.` };
    }

    const checker = program.getTypeChecker();
    const declaration = findType(source, typeName);
    if (declaration === undefined) {
        return { kind: 'refused', reason: `no type "${typeName}" in ${file}.` };
    }

    const type = checker.getTypeAtLocation(declaration);
    const properties = checker.getPropertiesOfType(type);
    if (properties.length === 0) {
        return { kind: 'refused', reason: `"${typeName}" has no fields: there is no domain to produce.` };
    }

    const fields = properties.map((property) => field(property, declaration, checker));
    return { kind: 'read', typeName, fields };
}

function field(property: ts.Symbol, at: ts.Node, checker: ts.TypeChecker): DomainField {
    const type = checker.getTypeOfSymbolAtLocation(property, at);
    const declared = checker.typeToString(type);
    const parts = type.isUnion() ? type.types : [type];

    const values: string[] = [];
    let finite = true;
    for (const part of parts) {
        const rendered = literalOf(part);
        if (rendered === undefined) {
            finite = false;
            continue;
        }
        values.push(rendered);
    }
    return { name: property.name, values, declared, finite };
}

/** The value written as source, or `undefined` when this member is not a literal. */
function literalOf(type: ts.Type): string | undefined {
    if (type.isStringLiteral()) {
        return JSON.stringify(type.value);
    }
    if (type.isNumberLiteral()) {
        return String(type.value);
    }
    if ((type.flags & ts.TypeFlags.Null) !== 0) {
        return 'null';
    }
    if ((type.flags & ts.TypeFlags.Undefined) !== 0) {
        return 'undefined';
    }
    if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
        // `intrinsicName` is the only public read that tells `true` from `false`.
        return (type as ts.Type & { intrinsicName?: string }).intrinsicName === 'true' ? 'true' : 'false';
    }
    return undefined;
}

function findType(source: ts.SourceFile, name: string): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined {
    let found: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined;
    const visit = (node: ts.Node): void => {
        if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.text === name) {
            found ??= node;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}
