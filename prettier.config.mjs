/**
 * Matches the style the codebase already writes: semicolons, single quotes, four-space
 * indent. The width is set at 130 rather than the usual 100 because this codebase carries
 * its reasoning in prose comments — 99% of its lines already fit under 130, and a narrower
 * ceiling would only rewrap code that is currently readable.
 *
 * @type {import('prettier').Config}
 */
export default {
    semi: true,
    singleQuote: true,
    printWidth: 130,
    tabWidth: 4,
};
