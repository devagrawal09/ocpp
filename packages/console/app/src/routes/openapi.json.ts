export async function GET() {
  const response = await fetch(
    "https://raw.githubusercontent.com/devagrawal09/oc-plus-plus/refs/heads/dev/packages/protocol/openapi.json",
  )
  const json = await response.json()
  return json
}
