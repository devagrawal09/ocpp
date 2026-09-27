export interface DocsNavItem {
  title: string
  slug: string
}

export interface DocsNavGroup {
  title?: string
  items: DocsNavItem[]
}

export interface DocsSection {
  key: "docs" | "cli" | "build" | "api"
  title: string
  landingSlug: string
  groups: DocsNavGroup[]
}

export const docsSections: DocsSection[] = [
  {
    key: "docs",
    title: "Docs",
    landingSlug: "index",
    groups: [
      {
        items: [
          { title: "Intro", slug: "index" },
          { title: "Config", slug: "config" },
        ],
      },
      {
        title: "Configure",
        items: [
          { title: "LSP", slug: "lsp" },
          { title: "Agents", slug: "agents" },
          { title: "Models", slug: "models" },
          { title: "Session drivers", slug: "drivers" },
          { title: "Skills", slug: "skills" },
          { title: "Commands", slug: "commands" },
          { title: "Plugins", slug: "plugins" },
          { title: "Providers", slug: "providers" },
          { title: "Snapshots", slug: "snapshots" },
          { title: "Compaction", slug: "compaction" },
          { title: "Formatters", slug: "formatters" },
          { title: "References", slug: "references" },
          { title: "Attachments", slug: "attachments" },
          { title: "MCP servers", slug: "mcp-servers" },
          { title: "REST APIs", slug: "openapi" },
          { title: "Permissions", slug: "permissions" },
          { title: "Instructions", slug: "instructions" },
          { title: "Session sharing", slug: "sharing" },
          { title: "Session warming", slug: "warming" },
        ],
      },
      {
        items: [
          { title: "Migrate from V1", slug: "migrate-v1" },
          { title: "Troubleshooting", slug: "troubleshooting" },
        ],
      },
    ],
  },
  {
    key: "cli",
    title: "CLI",
    landingSlug: "cli",
    groups: [
      {
        items: [{ title: "Intro", slug: "cli" }],
      },
    ],
  },
  {
    key: "build",
    title: "Build",
    landingSlug: "build",
    groups: [
      {
        items: [{ title: "Intro", slug: "build" }],
      },
      {
        title: "Plugins",
        items: [
          { title: "Overview", slug: "build/plugins" },
          { title: "Effect", slug: "build/plugins/effect" },
        ],
      },
      {
        title: "Client",
        items: [
          { title: "JavaScript", slug: "build/client" },
          { title: "Effect", slug: "build/client/effect" },
        ],
      },
      {
        title: "SDK",
        items: [
          { title: "Overview", slug: "build/sdk" },
          { title: "Effect", slug: "build/sdk/effect" },
          { title: "Cloudflare", slug: "build/sdk/cloudflare" },
        ],
      },
    ],
  },
  {
    key: "api",
    title: "API",
    landingSlug: "api",
    groups: [
      {
        title: "API",
        items: [{ title: "Overview", slug: "api" }],
      },
    ],
  },
]

export function docsHref(slug: string, anchor?: string) {
  const path = slug === "index" ? "" : `${slug.replace(/\/index$/, "")}/`
  return `${import.meta.env.BASE_URL}docs/${path}${anchor ? `#${anchor}` : ""}`
}

export function getDocsSection(slug: string) {
  return (
    docsSections.find((section) => section.groups.some((group) => group.items.some((item) => item.slug === slug))) ??
    docsSections[0]
  )
}
