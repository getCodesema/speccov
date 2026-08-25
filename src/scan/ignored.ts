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
    const ignored = await askGit(root, paths);
    return ignored === undefined ? paths : paths.filter((path) => !ignored.has(path));
}

const NUL = '\0';

async function askGit(root: string, paths: readonly string[]): Promise<Set<string> | undefined> {
    const child = Bun.spawn(['git', '-C', root, 'check-ignore', '--stdin', '-z'], {
        stdin: new TextEncoder().encode(paths.join(NUL) + NUL),
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const answer = await new Response(child.stdout).text();
    const code = await child.exited;

    // 0: at least one path ignored. 1: none. Everything else (128 outside a repository) is
    // a refusal to answer, and a refusal to answer must not read as "nothing is ignored".
    if (code !== 0 && code !== 1) {
        return undefined;
    }
    return new Set(answer.split(NUL).filter((line) => line !== ''));
}
