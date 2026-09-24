import { describe, expect, test } from "bun:test"
import { ToolHandle } from "@ocpp/codemode"
import { Agent } from "@ocpp/core/agent"
import { Session } from "@ocpp/core/session"
import { SessionMessage } from "@ocpp/core/session/message"
import { Tool } from "@ocpp/core/tool"
import { SubagentCustomTool } from "@ocpp/core/tool/plugin/subagent-custom"
import { execute } from "@ocpp/core/tool/runtime"
import { Effect } from "effect"

const context: Tool.Context = {
  sessionID: Session.ID.make("ses_child"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_parent"),
  id: Tool.CallID.make("call_custom"),
  progress: () => Effect.void,
}

const definition = {
  name: "decorate",
  description: "Decorate text",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  outputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  capabilities: ["echo"],
} as const

describe("SubagentCustomTool", () => {
  test("validates and exposes opaque handles", async () => {
    const handle = new ToolHandle(definition, (input) =>
      Effect.succeed({ text: (input as { text: string }).text + "!" }),
    )
    const handles = await Effect.runPromise(SubagentCustomTool.validate([handle]))
    const custom = SubagentCustomTool.make(handles)[0]
    expect(custom).toBeDefined()
    if (!custom) return

    const result = await Effect.runPromise(execute(custom, { text: "hello" }, context))
    expect(result.output).toEqual({ text: "hello!" })
    expect(result.metadata).toEqual({
      executionKind: "custom-tool",
      executionStatus: "completed",
      capabilities: ["echo"],
    })
  })

  test("rejects serialized definitions and duplicate names", async () => {
    await expect(
      Effect.runPromise(
        SubagentCustomTool.validate([
          {
            ...definition,
            code: "return input",
          },
        ]),
      ),
    ).rejects.toThrow("tool.define(...) handles")

    const first = new ToolHandle(definition, Effect.succeed)
    const second = new ToolHandle(definition, Effect.succeed)
    await expect(Effect.runPromise(SubagentCustomTool.validate([first, second]))).rejects.toThrow(
      "Duplicate custom tool: decorate",
    )
  })

  test("validates output and refuses handles after their activation closes", async () => {
    const invalid = new ToolHandle(definition, () => Effect.succeed({ wrong: true }))
    const custom = SubagentCustomTool.make([invalid])[0]
    expect(custom).toBeDefined()
    if (!custom) return
    await expect(Effect.runPromise(execute(custom, { text: "hello" }, context))).rejects.toThrow(
      "Tool returned an invalid value for its output schema",
    )

    invalid.close()
    await expect(Effect.runPromise(execute(custom, { text: "hello" }, context))).rejects.toThrow(
      "Tool handle is no longer active",
    )
  })
})
