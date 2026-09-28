import { base64Encode } from "@ocpp/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { installSseTransport } from "../utils/sse-transport"
import { currentSession } from "../utils/mock-server"

const serverA = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const serverB = "http://127.0.0.1:4097"
const directoryA = "C:/server-a"
const directoryB = "/home/server-b"
const sessionA = session("ses_server_a", directoryA, "Server A session")
const childSessionA = { ...session("ses_server_a_child", directoryA, "Server A child session"), parentID: sessionA.id }
const sessionB = session("ses_server_b", directoryB, "Server B session")

test("session settings use the remote server context", async ({ page }) => {
  await installSseTransport(page, { server: serverA })
  await installSseTransport(page, { server: serverB })
  await mockServers(page)
  await configureServers(page)

  await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  const sessionHeading = page.getByRole("heading", { name: sessionB.title, exact: true, includeHidden: true })
  await expect(sessionHeading).toBeVisible()
  await page.keyboard.press("Control+,")

  const settings = page.getByTestId("settings-screen")
  await expect(settings).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(settings.getByRole("tablist")).toHaveCSS("width", "328px")
  await expect(sessionHeading).toBeAttached()
  await expect(sessionHeading).toBeHidden()

  await settings.getByRole("tab", { name: "Models" }).click()
  await expect(settings.getByRole("switch", { name: "Server B Model" })).toBeEnabled()
  await expect(settings.getByRole("switch", { name: "Server A Model" })).toHaveCount(0)
  await settings.getByRole("button", { name: "Back to app" }).click()
  await expect(settings).toBeHidden()
  await expect(sessionHeading).toBeVisible()
})

async function configureServers(page: Page, tabs: { type: "session"; server: string; sessionId: string }[] = []) {
  await page.addInitScript(
    ({ serverB, tabs }) => {
      localStorage.setItem("ocpp.global.dat:server", JSON.stringify({ list: [serverB] }))
      localStorage.setItem("ocpp.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { serverB, tabs },
  )
}

async function mockServers(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== serverA && url.origin !== serverB) return route.fallback()
    const remote = url.origin === serverB
    const directory = remote ? directoryB : directoryA
    const sessions = remote ? [sessionB] : [sessionA, childSessionA]
    const requestDirectory = url.searchParams.get("location[directory]")
    if (requestDirectory && requestDirectory !== directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/api/provider")
      return json(route, {
        location: { directory },
        data: [
          {
            id: remote ? "server-b" : "server-a",
            name: remote ? "Server B Provider" : "Server A Provider",
            package: "test",
          },
        ],
      })
    if (url.pathname === "/api/model") return json(route, { location: { directory }, data: [model(remote)] })
    if (url.pathname === "/api/model/default") return json(route, { location: { directory }, data: model(remote) })
    if (url.pathname === "/api/agent") return json(route, { location: { directory }, data: [] })
    if (["/api/command", "/api/reference", "/api/question/request"].includes(url.pathname))
      return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp") return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json(route, { location: { directory }, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/project") {
      return json(route, [
        {
          id: remote ? sessionB.projectID : "project-server-a",
          canonical: directory,
          vcs: "git",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ])
    }
    if (url.pathname === "/api/project/current")
      return json(route, { id: remote ? sessionB.projectID : "project-server-a", directory, canonical: directory })
    if (url.pathname === "/api/session")
      return json(route, { data: sessions.map((session) => currentSession(session)), cursor: {} })
    if (url.pathname === "/api/session/active")
      return json(route, { data: Object.fromEntries(sessions.map((session) => [session.id, { type: "running" }])) })
    const currentSessionInfo = sessions.find((session) => url.pathname === `/api/session/${session.id}`)
    if (currentSessionInfo) return json(route, { data: currentSession(currentSessionInfo) })
    if (sessions.some((session) => url.pathname === `/api/session/${session.id}/message`))
      return json(route, { data: [], cursor: {} })
    if (sessions.some((session) => url.pathname === `/api/session/${session.id}/inbox`))
      return json(route, { data: [] })
    if (url.pathname === "/api/location") return json(route, { directory })
    if (url.pathname === "/api/vcs")
      return json(route, { location: { directory }, data: { branch: "main", defaultBranch: "main" } })
    if (url.pathname === "/api/pty/shells") return json(route, { location: { directory }, data: [] })
    return json(route, {})
  })
}

function session(id: string, directory: string, title: string) {
  return {
    id,
    slug: id,
    projectID: `project-${id}`,
    location: { directory },
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

function provider(id: string) {
  const name = id === "server-b" ? "Server B" : "Server A"
  return {
    all: [
      {
        id,
        name: `${name} Provider`,
        models: {
          [id]: {
            id,
            name: `${name} Model`,
            family: id,
            release_date: "2026-01-01",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: [id],
    default: { providerID: id, modelID: id },
  }
}

function model(remote: boolean) {
  const id = remote ? "server-b" : "server-a"
  const name = remote ? "Server B" : "Server A"
  return {
    id,
    modelID: id,
    providerID: id,
    name: `${name} Model`,
    family: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: Date.now() },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}
