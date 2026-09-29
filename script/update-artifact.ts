type Artifact = {
  channel: string
  name: string
  distribution: string
  version: string
  metadata: Record<string, unknown>
}

export namespace UpdateArtifact {
  export async function publish(artifact: Artifact) {
    if (process.env.GITHUB_ACTIONS !== "true") {
      console.log("skipped update artifact publication outside GitHub Actions")
      return
    }
    const requestURL = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (!requestURL || !requestToken) throw new Error("GitHub Actions OIDC is unavailable")

    const url = new URL(requestURL)
    url.searchParams.set("audience", "https://update.ocpp.ai")
    const tokenResponse = await fetch(url, { headers: { Authorization: `Bearer ${requestToken}` } })
    if (!tokenResponse.ok) throw new Error(`Failed to request GitHub OIDC token: ${tokenResponse.status}`)
    const token: unknown = await tokenResponse.json()
    if (!isRecord(token) || typeof token.value !== "string")
      throw new Error("GitHub OIDC response did not include a token")

    const response = await fetch("https://update.ocpp.ai/api/publish", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(artifact),
    })
    if (response.ok) return
    throw new Error(`Failed to publish update artifact: ${response.status} ${await response.text()}`)
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
