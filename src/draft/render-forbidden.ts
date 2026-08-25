import { basename, dirname, join } from 'node:path';
import type { DomainField } from './domain';
import type { Draft } from './render';

/**
 * Writes the draft of a ban, domain already filled in.
 *
 * The compiler provided what it knew: the finite values, written out in plain sight in the
 * file. The rest — the business sentence, what is forbidden, a value for the infinite
 * fields — throws at runtime. An unfinished draft does not load, so it cannot announce a
 * green light it never measured.
 *
 * The list is **written out**, not read on the fly: it stays in plain sight, and a role that
 * disappears shows up in review instead of silently dropping a case.
 */
export function renderForbidden(file: string, typeName: string, fields: readonly DomainField[]): Draft {
    const todos: string[] = [];
    const lines = fields.map((field) => `            ${field.name}: [${valuesOf(field, todos)}],`);

    // An infinite field weighs one value more: the one still to be provided.
    const widthOf = (field: DomainField): number => field.values.length + (field.finite ? 0 : 1);
    const total = fields.reduce((product, field) => product * widthOf(field), 1);
    const shape = fields.map(widthOf).join(' × ');

    todos.push(`write the business sentence "${typeName}" must never violate.`);
    todos.push(`say what is forbidden for a "${typeName}".`);

    const content = `/**
 * Draft produced by \`speccov draft --forbidden ${typeName}\`.
 *
 * Domain read from the type: ${shape} = ${total} cases, all exercised.
 * The finite values come from the compiler. What needed a decision throws.
 */
import { allOf, forbidden } from '@codesema/speccov';
import type { ${typeName} } from './${basename(file, '.ts')}';

function missing(what: string): never {
    throw new Error(\`TODO speccov: \${what}\`);
}

/** TODO speccov: ${todos[todos.length - 2] ?? ''} */
function intention(): string {
    return missing('write the sentence this ban defends');
}

/** TODO speccov: ${todos[todos.length - 1] ?? ''} */
function forbids(value: ${typeName}): boolean {
    return missing(\`say what is forbidden — got \${JSON.stringify(value)}\`);
}

export default [
    forbidden<${typeName}>({
        name: '${typeName} · forbidden',
        intention: intention(),

        // Written out, not read on the fly: a member that disappears shows up here, in review.
        cases: allOf<${typeName}>({
${lines.join('\n')}
        }),

        forbids,
        describe: (value) => JSON.stringify(value),
    }),
];
`;

    return { path: join(dirname(file), `${basename(file, '.ts')}.rules.ts`), content, todos };
}

/**
 * The values of the field. The infinite part becomes a call that throws, named by its type:
 * the compiler knows `adminAreaId` is a `string`, it does not know that "an area" and "no
 * area" are the two cases that matter.
 */
function valuesOf(field: DomainField, todos: string[]): string {
    if (field.finite) {
        return field.values.join(', ');
    }
    todos.push(`provide a value for "${field.name}: ${field.declared}".`);
    const asked = `missing('a value for ${field.name}: ${field.declared}')`;
    return [asked, ...field.values].join(', ');
}
