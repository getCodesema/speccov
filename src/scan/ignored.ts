import { spawnSync } from 'node:child_process';

/**
 * Filters out the paths the repository itself sets aside.
 *
 * A `.gitignore` already says what is not the project's code: generated directories,
 * working copies, artefacts. Without it, a scan trips over a worktree dropped inside the
 * repository and counts the same code twice — then reports it as two distinct scopes.
 *
 * Nothing is reimplemented: `git check-ignore` answers, with git's exact rules, index
 * included — a tracked file is never called ignored, even if a pattern would target it.
 * Outside a git repository there is no answer to be had: we keep everything.
 */
export async function dropIgnored(root: string, paths: readonly string[]): Promise<readonly string[]> {
    if (paths.length === 0) {
        return paths;
    }
    const ignored = askGit(root, paths);
    return ignored === undefined ? paths : paths.filter((path) => !ignored.has(path));
}

const NUL = '\0';

function askGit(root: string, paths: readonly string[]): Set<string> | undefined {
    const { status, stdout } = spawnSync('git', ['-C', root, 'check-ignore', '--stdin', '-z'], {
        input: paths.join(NUL) + NUL,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        // The answer grows with the repository: the default megabyte would cut it short.
        maxBuffer: Infinity,
    });

    // 0: at least one path ignored. 1: none. Everything else (128 outside a repository, no
    // status at all without git) is a refusal to answer, and a refusal to answer must not
    // read as "nothing is ignored".
    if (status !== 0 && status !== 1) {
        return undefined;
    }
    return new Set(stdout.split(NUL).filter((line) => line !== ''));
}
