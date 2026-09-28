import { createEffect, createMemo } from "solid-js"
import type { FormInfo } from "@ocpp/client/promise"
import { useParams } from "@solidjs/router"
import { showToast } from "@/shell/notifications/toast"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { useWorkspaceLocation } from "@/workspaces/location"
import { sessionQuestionForm } from "@/session/requests/session-request-tree"
import { createSessionBackground } from "@/session/requests/background"
import { useData } from "@/runtime/server/current"

export function createSessionRequestModel() {
  const params = useParams()
  const sdk = useWorkspaceLocation()
  const serverSDK = useServerSDK()
  const data = useData()
  const language = useLanguage()
  createEffect(() => {
    const id = params.id
    if (!id || serverSDK.connection.status() !== "connected") return
    void Promise.all([data.shell.sync({ directory: sdk().directory }), data.session.form.sync(id)]).catch(
      () => undefined,
    )
  })

  const questionRequest = createMemo((): FormInfo | undefined => {
    return sessionQuestionForm(data.session.list(), data.session.form.list, params.id)
  })

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!questionRequest()
  })

  const primary = () => {
    const id = params.id
    return !!id && !data.session.get(id)?.parentID
  }
  const background = createSessionBackground({
    sessionID: () => (primary() ? params.id : undefined),
    messages: data.session.message.list,
    sessions: data.session.list,
    status: data.session.status,
    shells: () => data.shell.list({ directory: sdk().directory }),
  })
  const moveToBackground = async () => {
    if (!primary()) return
    const sessionID = params.id
    if (!sessionID) return
    await serverSDK.api.session.background({ sessionID }).catch((error) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  return {
    blocked,
    questionRequest,
    background: {
      blocking: background.blocking,
      tasks: background.tasks,
      move: moveToBackground,
    },
  }
}

export type SessionRequestModel = ReturnType<typeof createSessionRequestModel>
