import { timingSafeEqual } from "node:crypto"
import { mkdir } from "node:fs/promises"

type TailStatus = {
  BackendState?: string
  Self?: { DNSName?: string }
  TailscaleIPs?: string[]
  AuthURL?: string
  Health?: string[]
}

export function control(options: {
  username: string
  password: string
  command: string[]
  directory: string
  healthURL: string
  tailscale: string[]
}) {
  const csrf = crypto.randomUUID()
  const authorization = Bun.CryptoHasher.hash(
    "sha256",
    `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`,
  )
  const state = {
    child: undefined as Bun.Subprocess | undefined,
    started: 0,
    exit: null as number | null,
    restarting: false,
    stopping: false,
    retry: undefined as ReturnType<typeof setTimeout> | undefined,
  }

  function start() {
    if (state.stopping) return
    state.child = Bun.spawn(options.command, {
      cwd: options.directory,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "CONTROL_PASSWORD" && key !== "TS_AUTHKEY"),
      ),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    })
    state.started = Date.now()
    void state.child.exited.then((code) => {
      state.exit = code
      if (state.stopping || state.restarting) return
      console.error(`OC++ exited (${code}); restarting in 2 seconds`)
      state.retry = setTimeout(start, 2000)
    })
  }

  async function stop() {
    clearTimeout(state.retry)
    const child = state.child
    if (!child || child.exitCode !== null) return
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
    await child.exited
    clearTimeout(timer)
  }

  async function restart() {
    if (state.restarting || state.stopping) return false
    state.restarting = true
    await stop()
    start()
    state.restarting = false
    return true
  }

  async function status() {
    const health = await fetch(options.healthURL, { signal: AbortSignal.timeout(3000) })
      .then(async (response) => ({
        healthy: response.ok,
        code: response.status,
        info: response.ok ? ((await response.json()) as unknown) : null,
      }))
      .catch(() => ({ healthy: false, code: null, info: null }))
    const result = await run([...options.tailscale, "status", "--json"])
    const tail = result.stdout.trim().startsWith("{") ? (JSON.parse(result.stdout) as TailStatus) : null
    const serve =
      tail?.BackendState === "Running" ? await run([...options.tailscale, "serve", "status", "--json"]) : null
    const config = serve?.stdout.trim().startsWith("{")
      ? (JSON.parse(serve.stdout) as { TCP?: Record<string, { HTTPS?: boolean }> })
      : null
    return {
      ocpp: {
        running: state.child?.exitCode === null,
        healthy: health.healthy,
        healthCode: health.code,
        info: health.info,
        pid: state.child?.pid,
        started: state.started,
        lastExit: state.exit,
        restarting: state.restarting,
      },
      tailscale: {
        serving: config?.TCP?.["443"]?.HTTPS === true,
        state: tail?.BackendState ?? "Unavailable",
        name: tail?.Self?.DNSName ?? null,
        ips: tail?.TailscaleIPs ?? [],
        loginURL: tail?.AuthURL || null,
        warnings: tail?.Health ?? [],
      },
    }
  }

  async function handler(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: !state.stopping })
    const supplied = Bun.CryptoHasher.hash("sha256", request.headers.get("authorization") ?? "")
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    }
    if (!timingSafeEqual(authorization, supplied))
      return new Response("Authentication required", {
        status: 401,
        headers: { ...headers, "WWW-Authenticate": 'Basic realm="OC++ Control", charset="UTF-8"' },
      })
    if (url.pathname === "/" && request.method === "GET")
      return new Response(
        (await Bun.file(new URL("dashboard.html", import.meta.url)).text()).replaceAll("__CSRF__", csrf),
        {
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${csrf}'; style-src 'nonce-${csrf}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
          },
        },
      )
    if (url.pathname === "/api/status" && request.method === "GET") return Response.json(await status(), { headers })
    if (url.pathname === "/api/restart" && request.method === "POST") {
      // Basic Auth is ambient browser authentication; restart also requires our page token and origin.
      const origin = request.headers.get("origin")
      if (
        request.headers.get("x-csrf-token") !== csrf ||
        !origin ||
        ![`http://${url.host}`, `https://${url.host}`].includes(origin)
      )
        return new Response("Forbidden", { status: 403, headers })
      const accepted = await restart()
      return Response.json({ accepted }, { status: accepted ? 200 : 409, headers })
    }
    return new Response("Not found", { status: 404, headers })
  }

  return {
    start,
    status,
    handler,
    restart,
    shutdown: async () => {
      state.stopping = true
      await stop()
    },
  }
}

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  return { code, stdout, stderr }
}

if (import.meta.main) {
  if (!process.env.CONTROL_PASSWORD || process.env.CONTROL_PASSWORD.length < 20)
    throw new Error("Set CONTROL_PASSWORD to at least 20 characters")
  await Promise.all(
    [
      "/data/home/.codex",
      "/data/home/.claude",
      "/data/home/.config/ocpp",
      "/data/workspaces",
      "/data/tailscale",
      "/run/tailscale",
    ].map((directory) => mkdir(directory, { recursive: true })),
  )
  const app = control({
    username: process.env.CONTROL_USERNAME ?? "admin",
    password: process.env.CONTROL_PASSWORD,
    command: ["ocpp", "serve", "--hostname", "127.0.0.1", "--port", "4096"],
    directory: "/data/workspaces",
    healthURL: "http://127.0.0.1:4096/api/health",
    tailscale: ["tailscale", `--socket=${process.env.TAILSCALE_SOCKET}`],
  })
  app.start()
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8080),
    hostname: "0.0.0.0",
    fetch: app.handler,
    error(error) {
      console.error(error)
      return new Response("Control request unavailable", { status: 503 })
    },
  })
  let daemon: Bun.Subprocess | undefined
  let stopping = false
  let serving = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const tail = ["tailscale", `--socket=${process.env.TAILSCALE_SOCKET}`]

  async function startTailscale() {
    if (stopping) return
    serving = false
    daemon = Bun.spawn(
      [
        "tailscaled",
        "--tun=userspace-networking",
        "--state=/data/tailscale/tailscaled.state",
        `--socket=${process.env.TAILSCALE_SOCKET}`,
      ],
      { stdout: "inherit", stderr: "inherit" },
    )
    void daemon.exited.then(() => {
      if (!stopping) retry = setTimeout(startTailscale, 2000)
    })
    await Bun.sleep(1500)
    const login = await run([
      ...tail,
      "up",
      "--hostname=ocpp-railway",
      "--accept-dns=false",
      "--timeout=3s",
      ...(process.env.TS_AUTHKEY ? [`--auth-key=${process.env.TS_AUTHKEY}`] : []),
    ])
    if (login.code !== 0)
      console.log("Tailscale needs attention; inspect the authenticated dashboard or use railway ssh")
  }

  async function configureServe() {
    if (stopping || serving) return
    const status = await run([...tail, "status", "--json"])
    if (status.code !== 0 || JSON.parse(status.stdout).BackendState !== "Running") return
    const result = await run([...tail, "serve", "--bg", "--https=443", "http://127.0.0.1:4096"])
    serving = result.code === 0
    console.log(serving ? "OC++ is available through private Tailscale HTTPS" : result.stdout + result.stderr)
  }

  await startTailscale()
  const interval = setInterval(() => void configureServe().catch(console.error), 15_000)
  void configureServe().catch(console.error)
  console.log(`Control dashboard listening on ${server.port}`)

  async function shutdown() {
    if (stopping) return
    stopping = true
    clearInterval(interval)
    clearTimeout(retry)
    server.stop()
    await app.shutdown()
    daemon?.kill("SIGTERM")
    if (daemon) await daemon.exited
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown())
  process.on("SIGINT", () => void shutdown())
}
