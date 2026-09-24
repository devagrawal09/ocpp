/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://ocpp.ai",

  // GitHub
  github: {
    repoUrl: "https://github.com/devagrawal09/oc-plus-plus",
    starsFormatted: {
      compact: "195K",
      full: "195,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/ocpp",
    discord: "https://discord.gg/ocpp",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "950",
    commits: "13,000",
    monthlyUsers: "16M",
  },
} as const
