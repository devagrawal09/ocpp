import { expect, story } from "../../storybook/playwright/story"

// Moved from packages/app/e2e/regression/session-timeline-notices.spec.ts
story("renders the moved location notice in its compact timeline style", async ({ mount, page }) => {
  const directory = `/Users/usrnk1/Developer/ocpp/${"nested-directory/".repeat(24)}session`
  await page.setViewportSize({ width: 480, height: 720 })
  const timeline = await mount("current-session-timeline-rows--conversation", { args: { scenario: "location" } })
  const notice = timeline.locator('[data-slot="session-timeline-notice"][data-type="location-switched"]')
  const label = notice.locator('[data-slot="session-timeline-notice-label"]')
  const value = notice.locator('[data-slot="session-timeline-notice-value"]')
  const tooltipTrigger = notice.locator('[data-component="tooltip-v2-trigger"]')

  await expect(label).toHaveText("Moved to")
  await expect(value).toHaveText(directory)
  await expect(notice).not.toContainText("·")
  await expect(notice.locator("svg")).toHaveCount(0)
  await expect(notice).toHaveCSS("height", "28px")
  await expect(notice).toHaveCSS("gap", "8px")
  await expect(notice).toHaveCSS("padding-top", "4px")
  await expect(notice).toHaveCSS("padding-bottom", "4px")
  await expect(label).toHaveCSS("font-size", "13px")
  await expect(label).toHaveCSS("font-weight", "530")
  await expect(label).toHaveCSS("line-height", "16px")
  await expect(label).toHaveCSS("color", "rgb(128, 128, 128)")
  await expect(value).toHaveCSS("font-size", "13px")
  await expect(value).toHaveCSS("font-weight", "440")
  await expect(value).toHaveCSS("line-height", "16px")
  await expect(value).toHaveCSS("color", "rgb(128, 128, 128)")
  await expect(value).toHaveCSS("text-overflow", "ellipsis")
  await expect(value).toHaveCSS("white-space", "nowrap")
  await expect(value).toHaveAttribute("dir", "ltr")
  await expect.poll(() => value.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)

  const tooltip = page.getByText("Session working directory changed", { exact: true })
  await label.hover()
  await expect(tooltip).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(tooltip).toBeHidden()
  await tooltipTrigger.focus()
  await expect(tooltipTrigger).toBeFocused()
  await expect(tooltip).toBeVisible()
})

for (const width of [1280, 390]) {
  for (const direction of ["ltr", "rtl"] as const) {
    story(
      `renders displayed results outside the collapsed trace at ${width}px in ${direction}`,
      async ({ mount, page }) => {
        await page.setViewportSize({ width, height: 900 })
        const timeline = await mount("current-session-timeline-rows--conversation", { args: { scenario: "display" } })
        const result = timeline.locator('[data-component="session-display-result"]')
        await page.evaluate((direction) => {
          document.documentElement.dir = direction
        }, direction)
        await expect(page.locator("html")).toHaveAttribute("dir", direction)
        await expect(result).toHaveCSS("direction", direction)

        await expect(
          timeline.locator('[data-timeline-row="Notice"] [data-component="session-display-result"]'),
        ).toHaveCount(1)
        await expect(
          timeline.locator('[data-timeline-row="Invocation"] [data-component="session-display-result"]'),
        ).toHaveCount(0)
        await expect(result).toHaveAttribute("aria-label", "Search results")
        await expect(result.locator('[data-slot="session-display-result-title"]')).toHaveText("Search results")
        await expect(result.locator("strong")).toHaveText("2")
        await expect(result.locator("th")).toHaveText(["File", "Line", "Exact"])
        await expect(result.locator("tbody tr").first().locator("td")).toHaveText(["src/app.ts", "12", "true"])
        await expect(result.locator("tbody tr").nth(1).locator("td").nth(2)).toHaveText("")
        await expect(result.locator("pre code")).toHaveText("login(user)")

        await expect(result).toBeVisible()
        await expect(result.locator("table")).toBeVisible()
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
          .toBe(true)
        await result.getByRole("button", { name: "src/app.ts", exact: true }).click()
        await expect(page.getByText("Story action: Opened src/app.ts")).toBeVisible()
      },
    )
  }
}
