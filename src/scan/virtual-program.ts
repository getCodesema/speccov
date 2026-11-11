import ts from 'typescript';

/**
 * A TypeScript program built in memory, for the tests.
 *
 * Type checking is now the detectors' source of truth: exercising them on a bare
 * `createSourceFile` would amount to testing something other than what runs.
 */
export function virtualProgram(files: Readonly<Record<string, string>>): {
    readonly program: ts.Program;
    readonly checker: ts.TypeChecker;
} {
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        lib: ['lib.es2022.d.ts'],
        strict: true,
        noEmit: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
    };
    const sources = new Map(
        Object.entries(files).map(([name, text]) => [
            name,
            ts.createSourceFile(name, text, options.target ?? ts.ScriptTarget.ES2022, true),
        ]),
    );
    const fallback = ts.createCompilerHost(options, true);
    const host: ts.CompilerHost = {
        ...fallback,
        getSourceFile: (name, ...rest) => sources.get(name) ?? fallback.getSourceFile(name, ...rest),
        fileExists: (name) => sources.has(name) || fallback.fileExists(name),
        readFile: (name) => sources.get(name)?.text ?? fallback.readFile(name),
        writeFile: () => undefined,
    };

    const program = ts.createProgram([...sources.keys()], options, host);
    return { program, checker: program.getTypeChecker() };
}
