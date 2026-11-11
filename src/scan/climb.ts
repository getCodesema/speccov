import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The nearest file of that name, from `start` upwards.
 *
 * We stop at the first one found, and never above the repository root: a file two levels
 * above the project no longer describes it.
 */
export function climbFor(name: string, start: string): string | undefined {
    let current = resolve(start);
    for (;;) {
        const candidate = join(current, name);
        if (existsSync(candidate)) {
            return candidate;
        }
        if (existsSync(join(current, '.git'))) {
            return undefined;
        }
        const parent = dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}
