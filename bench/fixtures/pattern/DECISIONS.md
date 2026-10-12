# Decisions (numbered, binding)
D-001 Modules live in src/<name>.ts, one concern per file.
D-002 Every module exports a factory `create<Name>()`. No classes anywhere.
D-003 Errors are returned as `{ ok: false, error: string }`, never thrown.
D-004 Tests are colocated as src/<name>.test.ts using bun:test, at least one test per exported function.
D-005 No external dependencies.
