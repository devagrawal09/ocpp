import { describe, expect, test } from "bun:test"
import type { FormInfo, SessionInfo } from "@ocpp/client/promise"
import { sessionQuestionForm } from "@/session/requests/session-request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as SessionInfo

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    title: "Questions",
    metadata: { kind: "question" },
    fields: [{ key: "q0", type: "string" }],
  }) as FormInfo

describe("sessionQuestionForm", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionQuestionForm(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(sessionQuestionForm(sessions, questions, "root")?.id).toBe("q-grand")
  })

  test("returns undefined without a question in the session's tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" }), session({ id: "other" })]
    const questions = {
      other: [question("q-other", "other")],
    }

    expect(sessionQuestionForm(sessions, questions, "root")).toBeUndefined()
  })

  test("skips forms that are not questions", () => {
    const sessions = [session({ id: "root" })]
    const forms = {
      root: [{ ...question("form", "root"), metadata: { kind: "integration" } }],
    }

    expect(sessionQuestionForm(sessions, forms, "root")).toBeUndefined()
  })
})
