# speccov

**You have 90% code coverage. What about your spec coverage?**

`speccov` looks for the behaviours no rule guarantees, and puts them to a human as closed
questions.

Vocabulary: the tool measures **spec coverage**, and the unit it reports is a **gap**.
"6 gaps left" is the sentence meant to circulate in an MR.

## Install and run

```sh
npx @codesema/speccov scan src
```

That is the static pass: it reads the code, executes nothing, and prints the sites worth a
rule. It needs Node 22.15 or later, and nothing else.

To write rules and run them, add speccov to the project:

```sh
npm install --save-dev @codesema/speccov

npx speccov scan src                      # what is proven, and what deserves a rule
npx speccov draft src/users.ts:41         # drafts the rule file for a site the scan printed
npx speccov src/users.rules.ts            # runs the rules, reports the gaps
npx speccov mutate src --run "npm test"   # alters the code, lists what nothing caught
```

A rules file is TypeScript and imports the project's own code. Under Node, speccov compiles
it on load with the options of the nearest `tsconfig.json`, so path aliases, enums and
decorators work as they do in the project. On Bun 1.3 or later, `bunx --bun speccov` runs
the same commands.

## The problem

Gates prove that the code does what the tests say. Nothing proves that the tests say the
right thing. When the AI writes the code _and_ the tests, the loop closes on itself and
verification is worth nothing.

Trust does not come from proof, it comes from **the map of the holes**. A "90% coverage"
says nothing about the 10%. Six sentences saying "nothing guarantees this" is actionable.

## The definition

> A **gap** is an input region where the behaviour of the code can be changed without any
> rule objecting.

Concretely: _surviving mutant_ ∩ _fuzz region where no rule fires_.
It is computable, it is short, and it can be counted.

## Who the report speaks to

To an agent, as much as to a human. That is what decides the shape of the output.

The loop we are after: an agent receives a plan, writes the code, `speccov` measures, and
the agent fixes **by referring to the plan** — not to its own judgement, which produced the
code in the first place. speccov is the only link the agent did not write.

Two consequences, and they are not cosmetic:

- **The false positive changes severity.** A human ignores a bad question. An agent acts on
  it, and degrades code that was fine. A doubtful question now costs a commit, not a second
  of attention.
- **Every hole must be named, never implicit.** Hence the `TODO`s that throw, the list of
  decisions left to a human, and the "Not measured" zone. An agent does not guess what it
  was not told — it invents.

## The four rule types

| Type            | What it asserts                                             | The real-world defect it catches                             |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `complexity()`  | The cost does not grow with the input size                  | the N+1 of `list-admin-users.ts:41`                          |
| `resource()`    | The observed peak stays under a ceiling                     | the 27 unbounded `Promise.all`                               |
| `metamorphic()` | An observation stays invariant from one variant to the next | the `total: items.length` of `list-admin-users.ts:36`        |
| `forbidden()`   | No input ever produces that                                 | the "no `adminAreaId` = global access" of `AreaScopeService` |

```sh
bun src/cli.ts examples/real-world-findings.rules.ts
```

All four defects are found. None is caught by the typed lint, the 90% coverage, the
mutation tests or the repo's e2e: **all of them pass 100% of the existing gates.**

### `allOf()` — the domain, not a list of cases

A forbidden rule tried against a hand-written list finds only what its author already
suspected. `allOf()` takes the **domain** and produces every case:

```ts
cases: allOf<Actor>({
    role: ['viewer', 'org_admin', 'platform_viewer', 'platform_admin'],
    adminAreaId: ['area-north', null],
});
```

Four roles times two area states: eight actors, all tried. The predicate is pure, the loop
runs in a millisecond — there is no reason to sample a share of it.

**Cases are produced from the simplest to the most twisted**, by distance from the first
value of each field. The first counterexample met is therefore **the smallest**, with no
shrinking to write: `forbidden()` already keeps the first one, and it turns out to be the
right one.

On that monorepo's scope defect, the hand-written list found one counterexample. The domain
finds **two**, and puts `viewer without an area` first — a role even less privileged than
`org_admin`, so a worse hole, that nobody had thought to write.

An absurd domain is **refused**, never silently sampled: twenty values across eight fields
make twenty-five billion cases — that is a typo, not a domain.

### Declared or default?

`origin: 'default'` **if and only if** you had no threshold to choose.
`complexity()` is default — "the cost does not grow" is a law, not a setting.
`resource()` makes you choose a ceiling, `forbidden()` and `metamorphic()` make you write a
business sentence: those are declared rules, and breaking one is a violation.

Four types are enough to cover the four real defects found in a 153k-line repository that
already passed 100% of its gates (typed lint, 90% coverage, mutation, e2e, API fuzzing).

## Spec format: no format, a rendering

- **Source of truth**: a `.rules.ts` next to the use case. Typed, imports the business
  types, executable, completion for free, zero parser to write.
- **What the human reads**: the rendered page — one sentence per rule.
- The `intention` field is **mandatory**. A rule with no readable sentence is an error.

Writing format ≠ reading format.

## The Trojan horse

Some rules are universal and **need not be written**:

- the number of queries does not grow with the input size → **N+1**
- outgoing concurrency is bounded → **unbounded fan-out**
- `total` is invariant under `(limit, offset)` → **broken pagination**

Immediate value, zero spec to write. And it teaches the user what a rule is.

## Status: working MVP

One default rule — **complexity** — and its counting probe.

```sh
bun src/cli.ts examples/list-admin-users.rules.ts
```

```
  ✓ 1 rule held
  ⚠ 1 gap

  gap 1/1   list-admin-users · current
  “The number of SQL queries grows by ≈ 1 per item (1→1, 2→2, 4→4, 8→8, 16→16). No written
  rule forbids it. Is this intended?”

     [y] this is a bug     [n] this is intended
```

The example faithfully reproduces the N+1 of a real-world monorepo
(`list-admin-users.ts:41`) and its fix. **speccov finds the first and validates the second,
without a single spec being written.** That is the success criterion we set ourselves: a
tool earns trust by first finding again what we already knew.

### What exists

- `complexity()`, `resource()`, `metamorphic()`, `forbidden()` — the four rule types
- `Counter` — the probe, ignorant of the domain
- `countingLogger()` — TypeORM adapter (`Logger` interface declared structurally, no
  dependency on the ORM)
- `run()` / `report()` / `exitCode()` — execution, rendering, exit code
- CLI: `speccov <file.rules.ts>`
- `loadAnswers()` / `applyAnswers()` / `accept()` — the memory of the answers
- `Gauge` — the concurrency probe, counterpart of `Counter`
- `allOf()` — the cartesian product of a finite domain, from the simplest to the most twisted
- `speccov draft <file> --forbidden <Type>` — the domain written from the type
- 118 tests, strict typecheck, zero production dependency

## `speccov scan` — the static pass

No execution, no wiring, no rule to write. It reads and parses, that is all.

```sh
speccov scan apps/api/src --tsconfig apps/api/tsconfig.json
```

The report has **four zones**, and the fourth is the one that makes it honest:

| Zone                       | Where the guarantee comes from                                 |
| -------------------------- | -------------------------------------------------------------- |
| **Proven by construction** | compiler flags, fixed-arity `Promise.all`                      |
| **Guaranteed by nobody**   | flags switched off, and the candidate sites for each rule type |
| **Not measured**           | what the pass did **not** look at, and why                     |

A report that shows only what it managed to verify, without saying what it could not, lies
by omission. That is the reproach made to a 90% coverage.

### What it detects

| Shape                                                  | Rule proposed                                             |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `Promise.all(collection.map(…))`                       | `resource()` — what concurrency ceiling?                  |
| a read (`find*`, `get*`, `load*`…) inside a `.map()`   | `complexity()` — should the cost grow?                    |
| a `{ items, total }` return                            | `metamorphic()` — does `total` survive a change of page?  |
| `Promise.all([a, b, c])`                               | **none** — bounded in writing, that is a guarantee        |
| `const TABLES = […]` then `TABLES.map(…)`              | **none** — the collection is fixed in the file            |
| `const batch = xs.slice(i, i + n)` then `batch.map(…)` | **none** — the batch is bounded by its width              |
| `X.map((i) => <button onClick={() => go(i)} />)`       | **none** — the call goes out on click, not per item       |
| `(await listDir(root)).map((e) => e.path)`             | **none** — the promise is on the receiver: a batched read |
| `for (const x of xs) { await go(x) }`                  | `complexity()` — should the wait grow with the list?      |
| `Promise.all([...inflight.values()])`                  | **none** — a drain: that work was started elsewhere       |
| `import { KEYS }` then `KEYS.map(…)`                   | **none** — the width is written, one file over            |
| `export function f(id: string) { await load(id) }`     | `forbidden()`: what bounds that `string`?                 |
| `export function f(id: string) { return id.trim() }`   | **none**: the value never leaves the process              |

The last question bears on a type, not on a behaviour, and a codebase holds many more
signatures than fan-outs. Two things keep it from burying the rest. It is only asked of a
parameter that goes on to an asynchronous call, read one hop away: a value that merely
feeds a computation stays where the types still hold. And the report gives it a block of
its own, `Typed, not bounded`, with a total and the files where it concentrates. The JSON
still carries every site.

### The shape it used to be blind to

Every question above reads **concurrency**: how many calls leave at once, under what ceiling. A
serial `await` has a concurrency of one, so it triggered nothing at all:

```ts
for (const container of containers) {
    await exec(runtime, ['rm', '-f', container], { timeoutMs: 30_000 }).catch(() => null);
}
```

The cost grows with the collection just as surely as a fan-out's, in time instead of sockets.
Measured on codesema and codesema-tools: **78 loops of this shape against 17 concurrency
sites** — the pass was silent on the more common of the two. That very loop sits two lines
under a `Promise.all` it was asking about wrongly.

Three filters keep it from being noise, because a serial loop is very often deliberate: the
collection must be unbounded, the awaited call must leave the process, and `Promise.all` is
left out since it carries its own question at its own address. Against 78 raw loops, 28 sites
are reported.

### It waits on the types it builds

`scan` builds a real `ts.Program` per scope, with module resolution: what a site means is read
from the types, not guessed from the shape. Two questions cannot be answered any other way.

**Is this promise being launched, or merely awaited?** `Promise.all(users.map((u) => sync(u)))`
opens one outgoing call per item. `Promise.all([...inflight.values()])` opens nothing at all:
the work is already running, and a ceiling here would bound nothing. Both hold N promises and
read the same by width, so speccov walks back to where the collection came from. Three shutdown
drains in codesema-tools used to be reported as fan-outs, and a ceiling on any of them would
have been a fix for a defect that was not there.

**How wide is a collection declared next door?** A name imported from another file is followed
to its declaration, and to the literal that gives it a width. The declaring file is read too:
`export const rows = []` filled by a `rows.push(…)` over there is an accumulator, and importing
it must not launder it.

What stays outside is what the program cannot show. A **parameter** keeps its question: the
width belongs to the callers, and an exported function has callers this scope may not even
contain. `runProbes(probes)` in codesema-tools is called twice, both times with a written list,
and it is still asked about — because nothing stops the third caller from passing a thousand.

The cost of that program is paid once per scope, and only for scopes that have something to
read: a generated scope declaring nothing but `.d.ts` files is skipped before the program is
built. Six of them were eating 15s of a 35s scan on codesema to type four files between them.

Test files are excluded: a fixture is not a production defect. But the exclusion is
**counted and displayed** — like everything the pass does not read (`.vue`, `.js`, `.mjs`).
Skipping in silence would be exactly the lie by omission that coverage is blamed for.

The `tsconfig.json` files are discovered by walking: a monorepo has one per app, of
differing strictness. The report says what is proven **in every** scope read, and names
those where a flag is missing.

And it never concludes beyond what it read: on that monorepo, 15 of the 19 `tsconfig.json`
have an unresolvable `extends`, so the report announces
`(reach: 4 of 19 scope(s) — see “Not measured”)` instead of saying "off everywhere".

Measured on codesema, 346 files typed across five scopes with their `node_modules` resolved:
**27s**, everything included, of which about 25 goes into building the programs. An earlier
figure of 0.78s on 1,566 files was measured where 15 of 19 `tsconfig.json` had an unresolvable
`extends`, so almost no program was ever built: it timed the refusal, not the work. Being
slower on a well-configured repository than on a broken one is the wrong way round, and it is
still true — a pre-commit hook is not the right home for this pass today.

### It does not conclude when it does not know

On a repository whose `node_modules` are not installed, an `extends` pointing at a workspace
package does not resolve — and **TypeScript then falls back to its defaults in silence**.
Concluding on that would produce ten false alarms on a project that is in fact fully strict.

`speccov` refuses: it says it could not resolve, and does not pronounce. The only diagnostic
it ignores is TS18003 ("no inputs were found"), by name, because it bears on the files to
compile and never on the `compilerOptions`.

### Setting a directory aside

A test harness or a browser-side client is real code, but not where a value enters the
system, and its sites drown the ones that matter. Nothing tells that from the code alone
without guessing by name. So the project says it, in a `.speccovignore` at its root:

```
# not where a value enters the system
tools/
apps/*/src/generated/**
*.actions.ts
```

The syntax is the subset of `.gitignore` a perimeter needs: `*`, `?`, `**`, comments, a
leading `/` to anchor, and a line without a slash matching at any depth. A negation (`!`)
is refused rather than misread. The file is found from the scanned directory upwards, and
its patterns are relative to where it sits, so the same line holds for `scan .` and for
`scan apps/api`.

What is set aside is counted, never silenced: the report ends with
`42 file(s) set aside by .speccovignore, 334 site(s) with them.`, and the JSON carries the
same two numbers under `notMeasured.ignored`.

## Accepting a gap promotes it to a rule

This is the heart of the product: **the human answer gets mechanised**.

```sh
speccov my.rules.ts --accept 'list-admin-users · current' --why "known N+1, ticket #4"
```

The threshold measured that day becomes a rule written into `.speccov/answers.json` — a file
**versioned and read in review**, not a cache:

```json
{
    "version": 1,
    "answers": [
        {
            "rule": "list-admin-users · current",
            "magnitude": 1,
            "detail": "The number of SQL queries grows by ≈ 1 per item (1→1, 2→2, …)",
            "at": "2026-08-22",
            "why": "known N+1, ticket #4"
        }
    ]
}
```

Then:

| Situation                   | Report                                                                                  | Exit    |
| --------------------------- | --------------------------------------------------------------------------------------- | ------- |
| The behaviour has not moved | `· 1 gap already accepted` — silenced but **counted**                                   | `0`     |
| It got better               | same                                                                                    | `0`     |
| **It got worse**            | `✗ 1 violation — Accepted on 2026-08-22 at a magnitude of 1; the threshold is exceeded` | **`1`** |

Accepting is therefore not going quiet: it is **setting a threshold the build will defend**.

### Two deliberate refusals

- **An acceptance never hides.** It is counted in the report. A forgotten acceptance would
  be exactly the blind spot the tool claims to fight.
- **An unreadable answers file throws.** Reading it as empty would make everything noisy;
  reading it as "all accepted" would make it blind. Both are worse than a halt.

### Answering a site works the same way

`scan` is the cheapest entry point, so it is the one that ends up in CI and in an agent loop —
and it had nowhere to write an answer down. A site a human had ruled out came back identical at
the next pass, carrying the same weight as a real N+1.

```sh
speccov scan . --accept 'packages/cli/src/probes.ts:73' --why "called with a written list only"
```

```json
{
    "version": 1,
    "sites": [
        {
            "file": "packages/cli/src/probes.ts",
            "kind": "unbounded-fanout",
            "shape": "Promise.all(running)",
            "at": "2026-08-26",
            "why": "called with a written list only"
        }
    ]
}
```

What is remembered is **the shape of the code, never the line**. A site moves down a file every
time something is inserted above it, and an answer keyed on a line number would expire on the
next commit, which is a way of remembering nothing. Reformatting is absorbed too, trailing
comma included.

The answer expires when that code changes, because it is then no longer the question anyone
answered — the same refusal as a threshold overrun above. And an answered site is **counted in
the report**, for the same reason an accepted gap is: a forgotten acceptance is the blind spot
this tool exists to refuse.

## On a real TypeORM

The adapter filters out the infrastructure, because TypeORM passes **everything** to the
logger:

```
SELECT version()                          handshake
SELECT current_schema() AS "currentSchema"    same, other shape
START TRANSACTION / COMMIT                transaction boundaries
SELECT … FROM "pg_tables"                 synchronize introspection
```

A 2-line `save()` emits **4 events for 1 logical write**. `isDataQuery()` sets them aside —
and stays **deliberately conservative**: under-counting would make N+1s _slip through_, and
that is the dangerous direction. When in doubt, a query counts.

The integration test runs against a real Postgres, and skips itself without one:

```sh
docker run -d --rm -e POSTGRES_PASSWORD=speccov -e POSTGRES_DB=speccov \
  -p 55432:5432 docker.io/library/postgres:17-alpine
SPECCOV_PG_URL=postgres://postgres:speccov@localhost:55432/speccov bun test
```

It checks that one `findOneBy` per item is seen as an N+1 at ≈ 1 query per item, and that a
de-duplicated `findBy(In(…))` stays constant.

## `speccov draft` — the bridge

```sh
speccov draft apps/api/.../list-admin-users.ts:41
```

**The bridge is not generation, it is harvesting.** The wiring already exists: in the use
case (constructor, dependencies) and in the neighbouring spec (doubles, factories, argument
order). `draft` goes and fetches it, and writes by hand only what is left.

| What the subject needs               | Where it comes from                           | Derived? |
| ------------------------------------ | --------------------------------------------- | -------- |
| The class and the constructor order  | AST of the use case                           | ✅       |
| The double factories and their paths | `buildMock*` imports of the neighbouring spec | ✅       |
| The call to count                    | the `this.x.find…()` spotted in the `.map()`  | ✅       |
| The public entry point               | walked up from the private method             | ✅       |
| The collection of size `size`        | —                                             | ❌ human |
| A valid command                      | —                                             | ❌ human |

On the real site in that monorepo, **2 decisions** are left instead of a blank page.

### Two guarantees

**It refuses rather than guesses.** Two reads in the same `.map()`, a private method called
by two public methods, a class with no injected constructor: it names the ambiguity and
stops. A subject that measures the wrong thing would produce a reassuring, false green —
worse than no subject at all.

**An unfinished draft throws.** Every hole is a function that `throw`s. The subject cannot
run while it is incomplete, so it cannot lie.

### The public entry point

The `.map()` is often inside a private method. Calling it would be impossible and would
measure an internal cog instead of the use case: `draft` walks up to the public method that
calls it. If there are zero or several, it refuses.

### `draft --forbidden` — the domain written from the type

```sh
speccov draft src/identity/actor.ts --forbidden Actor
```

A forbidden rule cannot be spotted statically: it is a business sentence. But the **input
space** is in the type — and the compiler is there when the draft is written, whereas it
will be gone at run time.

```ts
cases: allOf<Actor>({
    role: ["viewer", "org_admin", "platform_viewer", "platform_admin"],
    adminAreaId: [missing('a value for adminAreaId: string | null'), null],
    suspended: [false, true],
}),
```

| What the type knows                          | Written? |
| -------------------------------------------- | -------- |
| The members of a literal union               | ✅       |
| `null` and `undefined` of an optional type   | ✅       |
| Both faces of a boolean                      | ✅       |
| A value for a free `string` or `number`      | ❌ human |
| The business sentence, and what is forbidden | ❌ human |

**The list is written into the file, not read on the fly.** A type read dynamically would
drop a case in silence the day a member disappears, and the rule would stay green. Written
down, the disappearance shows up in review. It is the same refusal of silence as everywhere
else.

The share the type does not bound becomes a `missing(…)` — a call that throws when the
module loads. The draft cannot run while it is incomplete.

## `speccov mutate` — the second engine

Rules catch the properties we know how to name. Mutation catches the rest: it alters the
code and watches whether **anything at all** objects.

```sh
speccov mutate src/scan --run "bun test" --limit 25
```

```
  25 mutants tried, 11 killed.
  ⚠ 14 survivor(s) — that many behaviours nobody guarantees.

  survivor 3/14   src/scan/guarantees.ts:18  (string emptied)
  “I replaced  'useUnknownInCatchVariables'  with  ""  and nothing
    objected. Should this behaviour be guaranteed?”
```

**A surviving mutant is a gap in the strong sense**: the behaviour changed and neither rule
nor test flinched.

### Why not Stryker

The catalogue of operators comes from the state of the art (Stryker, PIT), but it is
reimplemented on the TypeScript AST that `scan` already parses. Three reasons:

- **The budget.** Stryker mutates everything and re-runs the whole suite. Here you choose
  the scope and the limit: 25 mutants in 8.8s, compatible with a pre-push.
- **The granularity.** Stryker asks "is this mutant killed by a _test_?". speccov asks
  "by _anything at all_ — rule or test?". That is not the same question.
- **The independence.** No inherited runner, config or plugin.

### Safety

Mutation writes into your files. Three protections:

- the restore is in a `finally`, with the original kept in memory — even a command that
  crashes leaves the source intact;
- `speccov mutate` **refuses to run** outside a git repository, or on a scope that has
  uncommitted changes: `git checkout` must stay a way back;
- the mutants generated beyond `--limit` are **counted and declared**, never silenced.

### It applied itself to itself

First pass on `src/scan`: **14 survivors out of 25**, all on the `FLAGS` table of
`guarantees.ts`. You could empty a flag's name or invert its `impliedByStrict` on 8 entries
out of 10 without a single test flinching.

The answer to a survivor is to write the missing rule — a complete truth table. Second pass
on the same scope: **25 mutants, 25 killed, no survivor.**

## Existing bricks — do not rewrite

- `fast-check` — generation and _shrinking_ (the minimal counterexample is what makes the report readable)
- `@stryker-mutator/core` — `--incremental` for the pre-push delta, JSON report in the
  `mutation-testing-report-schema` schema
- No Zod 4 → fast-check bridge maintained to this day (`zod-fast-check` stopped in 2023):
  go through `z.toJSONSchema()` for the width, hand-written arbitraries for the depth

## Decisions taken

| Date       | Decision                                                   | Why                                                                   |
| ---------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| 2026-08-22 | A dependency of the codesema CLI, not a standalone product | YAGNI. Extraction kept free: separate repo + `bin` entry              |
| 2026-08-22 | TypeScript / Bun, not Rust                                 | The core has to **execute user TypeScript** (predicates, arbitraries) |
| 2026-08-22 | One language, TS                                           | Premature multi-language has killed a hundred quality tools           |
| 2026-08-22 | No dedicated domain name                                   | No value until there is a standalone product                          |
| 2026-11-11 | Runs on Node as well as on Bun                             | A TypeScript project already has Node: `npx` is enough                |

## Identified risks

1. **The slowness of mutation is adoption killer no. 1.** Prove < 10s in pre-push,
   otherwise the hook gets disabled in the second week.
2. **The false positive is lethal** for a tool of trust. From the start it needs: equivalent
   mutant, judged once by a human, remembered forever.
3. "Intent coverage" is **not a budget line**. It sells inside the budget that exists: "can
   I trust the agent's PR?"
4. **The N+1 is the worst example to lead with.** It is the only one of the four defects
   with mature competition — QueryGuard, Scout, and Prisma's built-in dataloader. The scope
   defect of `AreaScopeService` has none: there, the code is correct, typed, tested, and
   does the wrong thing. That is where nobody stands opposite.
5. **`draft` still refuses 62% of third-party sites**, and for named reasons. The biggest —
   a `Promise.all(promises)` whose array is built elsewhere — is worth 58 sites on its own:
   the collection is not at the site, there is nothing to wire without guessing.
6. **`lobehub` remains unscannable** past 12 GB. Consumption does not follow the number of
   files, so it is not a problem of scale but of shape.

## Contributing

```bash
bun install    # installs the dependencies and arms the git hooks
bun run verify # typecheck + lint + the whole suite, the same thing CI runs
```

**One prerequisite that `bun install` cannot cover: [gitleaks](https://github.com/gitleaks/gitleaks).**
It is a Go binary, not an npm package — the package named `gitleaks` on npm is unrelated to
the project. Install it from the official release, Homebrew, or your distribution. Without
it the `pre-commit` and `pre-push` hooks fail instead of passing silently: a secret scanner
that is absent must not read as a repository that is clean.

What the hooks do, and where:

| Hook         | What runs                                                             |
| ------------ | --------------------------------------------------------------------- |
| `pre-commit` | `gitleaks protect --staged`, then prettier and oxlint on staged files |
| `commit-msg` | commitlint — Conventional Commits                                     |
| `pre-push`   | `gitleaks` over the unpushed commits, typecheck, and the test suite   |

CI runs the same checks on every pull request, plus `publint` and a full-history secret
scan. The hooks are the fast loop; CI is the one that cannot be skipped with `--no-verify`.
