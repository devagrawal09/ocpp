# Core Tool Architecture

`src/tool.ts` owns the Location-scoped tool service, registrations, effective lookup, execution, and terminal outcomes. This folder contains its supporting runtime modules and built-in plugins.

## Representations

- Plugin authors get schema-derived input types at the `ToolDraft.add` boundary through `Tool`.
- The heterogeneous Core registry deliberately erases registered definitions to `Tool.Info`. Use `any` at this internal boundary; do not replace it with `unknown`, JSON-value plumbing, casts, or compiled wrapper types solely to preserve type safety after registration.
- Executors return model content and metadata alongside declared machine output. Shipped built-ins and plugin tools use the same runtime shape after registration.
- `src/tool.ts` stores canonical Location registrations, derives LLM definitions, executes tools, and normalizes model content and images.
- Built-in tool plugins live in `tool/plugin`.

Do not add a second executable entry type, registry-owned executor, authorization callback, output-path callback, or legacy normalization path.

## Construction

Tool schemas use `input` and `output` terminology. Each tool carries its name, options, schemas, and executable behavior in one object.

Location-scoped built-in layers acquire every required Location service while the layer is constructed. The executor captures those services.

Leaves own resolution and side-effect ordering. Translate only expected typed errors into `ToolFailure`; do not use `catchCause`, because interruption and defects must survive. Question dismissals travel as defects beneath leaf `mapError` blankets and resurface as typed failures at `SessionModelRequest.executeTool`; leaves must never catch or convert them.

## Registration

Built-ins, plugins, and MCP install tools through `Tool.Service.transform`, adding complete tool objects to the draft. A tool may provide a namespace, which places it at `tools.<namespace>.<tool>` in Code Mode. The model is only ever offered one tool, `execute`: every registered tool is reachable only from code, and an agent receives `execute` exactly when its tool list holds at least one tool. Do not add a way to put a registered tool on the provider's tool list.

Session `context` hooks see only `execute`, so per-request tool customization belongs in the `tool` `catalog` hook. `Tool.snapshot` runs it with the Session, agent, and model (the model is absent for command and event handler runs), keyed by Code Mode path: an edited description reaches the catalog and `tools.search`, and a removed entry is neither listed nor callable. The catalog instructions show only each description's first line, so information the model needs up front, such as the subagent list, also needs an instruction source.

The service uses shared `State` to replay synchronous transforms in registration order against a fresh draft. `Tool.Service.reload()` rebuilds from captured source data without changing registration precedence. Registrations are scoped and return a real, idempotent `dispose` Effect:

- The latest valid active registration for the same effective name wins.
- `update` and `remove` target effective names and do nothing for missing tools. Updates preserve the name and namespace; invalid updates leave the previous definition intact. Creating a tool requires `add`.
- Disposing a registration or closing its scope removes only its transform and rebuilds from the remaining transforms, revealing any earlier definition it overrode.
- Each model request captures the effective definitions and executors it advertises; later reloads and disposal affect later snapshots. Captured executors may still reference mutable producer-owned state.

MCP owns one stable tool transform that reads its latest discovered tools. Tool-list changes update that source and reload the tool state instead of re-registering at the end of the transform order. MCP refresh therefore preserves the precedence of later plugin overrides.

Type safety ends at registration. The registry validates model input and declared output at runtime and should not carry producer schema generics through storage or execution.

`Tool.Service` is Location-scoped. Do not make the registry process-global or construct a separate application-tool service for each Location.

## Tool lists

A Session's Code Mode catalog is exactly its tool list (`tool/lists.ts`), a plain `ToolLists.Selection` of Code Mode paths, where a path selects a tool or a whole namespace. A top-level Session's list comes from `init.ts` for its agent (`tool/init.ts` evaluates it) or the built-in default; a subagent's is the paths its caller passed, projected from `session.tools.selected`. Tools lent to the Session, such as the call's `tool.define` handles and `submit_result`, join it. The compile check refuses every other path as `UnknownTool`.

Nothing authorizes execution: every tool on the list runs. Do not add approval prompts, allow or deny rules, or per-argument checks to the registry or to leaves. A tool the agent should not have belongs off its list, or behind a `tool.define` wrapper in `init.ts`.

`init.ts` handles live for one execution, so each execution evaluates `init.ts` again in its own scope, and the execution row stores the selection it was admitted with so a resumed run rebuilds the same catalog. Lists are applied before the `tool` `catalog` hook, which sees and shapes only listed tools.

A tool declared with `acceptsToolHandles` receives the calling execution's catalog in `Tool.Context.catalog`, so it can resolve tool references it is passed. `lent` marks entries that are not in the Location's registry; they can be handed on only as those tools, not by their paths.

## Output

Built-ins return complete tool responses. `Tool.Snapshot.execute` is the local execution boundary. Generic output bounding is applied by the Session runner after execution.

Producer capture remains local to producers. Shell stores combined process output in its backing file and returns a bounded tail with the full-output path when truncated.

## Current Gaps

- Future Session-scoped registrations still need an explicit canonical registration design.
