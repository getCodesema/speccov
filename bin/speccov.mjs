#!/usr/bin/env node
// Runs speccov on the runtime the project already has.
//
// The rules pass imports the user's TypeScript, and this package ships its own sources as
// they are. Bun runs TypeScript by itself. Node only strips the types, and stops at the
// first import without an extension, the first path alias, the first enum or decorator.
// So under Node the TypeScript compiler speccov already depends on does that work, file
// by file, with the options of the tsconfig nearest to each file.
import { readFileSync } from 'node:fs';
import nodeModule from 'node:module';
import { dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const TYPESCRIPT_FILE = /\.[cm]?tsx?$/u;
const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

// Reading a tsconfig also lists the files it includes. Only its options matter here.
const configHost = { ...ts.sys, readDirectory: () => [], onUnRecoverableConfigFileDiagnostic: () => {} };
const optionsByConfig = new Map();

function optionsFor(fileName) {
    // A dependency was not written under the project's tsconfig: it gets the defaults.
    const config = fileName.includes(`${sep}node_modules${sep}`)
        ? undefined
        : ts.findConfigFile(dirname(fileName), ts.sys.fileExists);
    const key = config ?? '';
    let options = optionsByConfig.get(key);
    if (options === undefined) {
        const parsed = config === undefined ? undefined : ts.getParsedCommandLineOfConfigFile(config, undefined, configHost);
        // TODO(ceiling): every file comes out as an ES module, so a project that relies on
        // `require` or `__dirname` in its TypeScript does not load: emit CommonJS for those.
        options = {
            ...parsed?.options,
            module: ts.ModuleKind.ESNext,
            importHelpers: false,
            sourceMap: false,
            inlineSourceMap: true,
            inlineSources: true,
        };
        optionsByConfig.set(key, options);
    }
    return options;
}

function resolve(specifier, context, nextResolve) {
    try {
        return nextResolve(specifier, context);
    } catch (error) {
        if (context.parentURL?.startsWith('file:') !== true) {
            throw error;
        }
        const parent = fileURLToPath(context.parentURL);
        const found = ts.resolveModuleName(specifier, parent, optionsFor(parent), ts.sys).resolvedModule;
        if (found === undefined || DECLARATION_FILE.test(found.resolvedFileName)) {
            throw error;
        }
        return { url: pathToFileURL(found.resolvedFileName).href, shortCircuit: true };
    }
}

function load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !TYPESCRIPT_FILE.test(url)) {
        return nextLoad(url, context);
    }
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
        compilerOptions: optionsFor(fileName),
        fileName,
    });
    return { format: 'module', source: outputText, shortCircuit: true };
}

if (process.versions.bun === undefined) {
    // The inlined source maps keep an error raised by a rule on the line the user wrote.
    process.setSourceMapsEnabled(true);
    nodeModule.registerHooks({ resolve, load });
}

await import('../src/cli.ts');
