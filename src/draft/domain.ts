import ts from 'typescript';

export type DomainField = {
    readonly name: string;
    /** The values, already rendered as TypeScript source. */
    readonly values: readonly string[];
    /** The declared type, as it is written. Used in the message when a value is needed. */
    readonly declared: string;
    /** False when part of the type is infinite: a `string`, a `number`, an object. */
    readonly finite: boolean;
    /**
     * The boundary values the type allows and that nobody writes by hand. Empty on a finite
     * field, where the compiler already wrote every case.
     */
    readonly edges: readonly string[];
};

/**
 * The boundary values of a primitive.
 *
 * They are mechanical: no business knowledge says that an empty string or a `NaN` deserves a
 * look, only the type does. That is what separates them from the value a human must still
 * provide, which stays a `missing()`.
 *
 * The lists are deliberately short. `allOf()` multiplies the fields, so each value added here
 * widens the whole product. Four per type is what earns its place.
 */
const STRING_EDGES: readonly string[] = ["''", "' '", "'\\u0301'", "'x'.repeat(10_000)"];
const NUMBER_EDGES: readonly string[] = ['0', '-1', 'Number.NaN', 'Number.MAX_SAFE_INTEGER'];

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
    const edges = new Set<string>();
    let finite = true;
    for (const part of parts) {
        const rendered = literalOf(part);
        if (rendered === undefined) {
            finite = false;
            for (const edge of edgesOf(part)) {
                edges.add(edge);
            }
            continue;
        }
        values.push(rendered);
    }
    return { name: property.name, values, declared, finite, edges: [...edges] };
}

/** The boundary values of an infinite part, or nothing when the type is not a known primitive. */
function edgesOf(type: ts.Type): readonly string[] {
    if ((type.flags & ts.TypeFlags.String) !== 0) {
        return STRING_EDGES;
    }
    if ((type.flags & ts.TypeFlags.Number) !== 0) {
        return NUMBER_EDGES;
    }
    return [];
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
