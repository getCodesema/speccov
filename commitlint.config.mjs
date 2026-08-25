/**
 * Conventional Commits, enforced on `commit-msg` by lefthook.
 *
 * One deviation from the preset: `header-max-length` is raised from 100 to 140. Subjects
 * here are deliberately descriptive — the longest in the history is 89 characters — and a
 * ceiling that the established practice keeps brushing against is a ceiling that gets
 * bypassed. 140 is still a real bound.
 */
export default {
    extends: ['@commitlint/config-conventional'],
    rules: {
        'header-max-length': [2, 'always', 140],
    },
};
