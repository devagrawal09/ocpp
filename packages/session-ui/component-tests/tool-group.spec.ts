import { expect, story } from "../../storybook/playwright/story"

for (const { width, direction } of [
  { width: 840, direction: "ltr" },
  { width: 390, direction: "rtl" },
] as const) {
  story(`renders one ordered Code Mode trace at ${width}px in ${direction}`, async ({ mount, page }) => {
    await page.setViewportSize({ width, height: 600 })
    const root = await mount("current-tool-group--code-mode-trace")
    await root.evaluate((element, dir) => element.setAttribute("dir", dir), direction)
    const group = root.locator('[data-component="collapsed-tool-group"]')
    await expect(group.getByRole("button", { name: "Code Mode: 8 steps", exact: true })).toBeVisible()
    const rows = group.locator('[data-slot="context-tool-group-item"]')
    await expect(rows).toHaveCount(8)
    await expect(rows).toHaveText([
      /Assignedfiles= \[package.json, src\] \(24 items\)/,
      /Mapped24 items-> 24 paths/,
      /Condition metfiles\.length > 0/,
      /Called `search`.*package metadata/,
      /Assignedreader= tools.read/,
      /Read.*package.json/,
      /LoggedLoaded package opencode/,
      /Final result\{ total: 1482 \}/,
    ])
    await expect(root.locator('[data-timeline-part-id="codemode_execute"]')).toHaveCount(0)
    await expect(root.locator('[data-timeline-part-id="codemode_execute:3"]')).toBeVisible()
    await expect(root.locator('[data-component="codemode-trace"]').first()).toHaveCSS("direction", direction)
  })
}

story("renders parallel Execute calls separately without completion notices", async ({ mount }) => {
  const root = await mount("current-session-terminal-work--parallel-code-mode")
  const groups = root.locator('[data-component="collapsed-tool-group"]')
  await expect(groups).toHaveCount(3)
  await expect(groups.getByRole("button", { name: "Code Mode: 3 steps", exact: true })).toHaveCount(3)
  await expect(root.getByText("Code Mode execution", { exact: true })).toHaveCount(0)
  expect(await groups.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-timeline-part-ids")))).toEqual([
    "parallel_execute_a:0,parallel_execute_a:1,parallel_execute_a:2",
    "parallel_execute_b:0,parallel_execute_b:1,parallel_execute_b:2",
    "parallel_execute_c:0,parallel_execute_c:1,parallel_execute_c:2",
  ])
})

for (const reasoningDefaultOpen of [false, true]) {
  story(
    `keeps ordered thoughts and tool-only counts with reasoning ${reasoningDefaultOpen ? "expanded" : "collapsed"}`,
    async ({ mount }) => {
      const root = await mount("current-tool-group--mixed-reasoning", { args: { reasoningDefaultOpen } })
      const group = root.locator('[data-component="collapsed-tool-group"]')
      const used = group.getByRole("button", { name: /^Used \d+ Read, Skill$/ })
      const first = group.locator('[data-timeline-part-id="reasoning_first"]')
      const second = group.locator('[data-timeline-part-id="reasoning_second"]')
      await expect(used).toHaveAttribute("aria-expanded", "true")
      await expect(used).toHaveAccessibleName("Used 4 Read, Skill")
      await expect(
        group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
      ).toHaveText("4 Read, Skill")
      await expect(group.locator('[data-slot="context-tool-group-item"]')).toHaveText([
        /Read.*group\.ts/,
        /Thought/,
        /Loaded.*opencode.*frontend-design.*skills/,
        /Thought/,
        /Loaded.*rtl-aware-development.*skill/,
      ])
      await expect(
        group.locator('[data-timeline-part-ids="reasoning_skill_first,reasoning_skill_second"]'),
      ).toBeVisible()
      await expect(first.getByRole("button", { name: "Thought", exact: true })).toHaveAttribute(
        "aria-expanded",
        String(reasoningDefaultOpen),
      )
      await expect(second.getByRole("button", { name: "Thought", exact: true })).toHaveAttribute(
        "aria-expanded",
        String(reasoningDefaultOpen),
      )
      await first.getByRole("button", { name: "Thought", exact: true }).click()
      await root.getByRole("button", { name: "Append follow-up read", exact: true }).click()
      await expect(used).toHaveAccessibleName("Used 5 Read, Skill")
      await expect(
        group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
      ).toHaveText("5 Read, Skill")
      await expect(group.locator('[data-slot="context-tool-group-item"]')).toHaveText([
        /Read.*group\.ts/,
        /Thought/,
        /Loaded.*opencode.*frontend-design.*skills/,
        /Thought/,
        /Loaded.*rtl-aware-development.*skill/,
        /Read.*group\.test\.ts/,
      ])
      await expect(first.getByRole("button", { name: "Thought", exact: true })).toHaveAttribute(
        "aria-expanded",
        String(!reasoningDefaultOpen),
      )
      await expect(second.getByRole("button", { name: "Thought", exact: true })).toHaveAttribute(
        "aria-expanded",
        String(reasoningDefaultOpen),
      )
      if (reasoningDefaultOpen) {
        await expect(
          first.getByText("The renderer groups adjacent tools. Check the relevant skills before changing it."),
        ).toBeHidden()
        return
      }
      await expect(
        first.getByText("The renderer groups adjacent tools. Check the relevant skills before changing it."),
      ).toBeVisible()
    },
  )
}

story("summarizes subagents as Agent while retaining their card titles", async ({ mount }) => {
  const root = await mount("current-tool-group--mixed-tools")
  const group = root.locator('[data-component="collapsed-tool-group"]')
  await expect(group.getByRole("button", { name: "Used 4 Shell, Read, Agent", exact: true })).toBeVisible()
  await expect(
    group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
  ).toHaveText("4 Shell, Read, Agent")
  await expect(group.locator('[data-component="task-tool-title"]')).toHaveText(["General", "Explore"])
})

for (const width of [840, 390]) {
  story(`keeps grouped cards inside their trigger bounds at ${width}px`, async ({ mount, page }) => {
    await page.setViewportSize({ width, height: 600 })
    const root = await mount("current-tool-group--mixed-tools")
    const group = root.locator('[data-component="collapsed-tool-group"]')
    const trigger = group.getByRole("button", { name: "Used 4 Shell, Read, Agent", exact: true })
    const header = group.locator('[data-component="context-tool-group-trigger"]')
    await expect(header.locator('[data-slot="basic-tool-tool-title"]')).toHaveText("4 Shell, Read, Agent")
    await expect(header.locator('[data-component="tag"]')).toHaveCount(0)
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    for (const action of ["click", "Enter", "Space"] as const) {
      if (action === "click") await trigger.click()
      if (action !== "click") await trigger.press(action)
      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await expect(group.locator('[data-component="context-tool-group-list"]')).toBeHidden()
      await expect(trigger).toBeFocused()
      if (action === "click") await trigger.click()
      if (action !== "click") await trigger.press(action)
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await expect(group.locator('[data-component="context-tool-group-list"]')).toBeVisible()
      await expect(trigger).toBeFocused()
    }
    const cards = group.locator('[data-component="task-tool-surface"]')
    await expect(cards).toHaveCount(2)
    await expect
      .poll(() =>
        cards.evaluateAll((nodes) =>
          nodes.map((node) => {
            const card = node.getBoundingClientRect()
            const trigger = node.closest('[data-component="tool-trigger"]')!.getBoundingClientRect()
            const item = node.closest('[data-slot="context-tool-group-item"]')!.getBoundingClientRect()
            return (
              card.height === 36 &&
              card.top >= trigger.top &&
              card.bottom <= trigger.bottom &&
              card.top >= item.top &&
              card.bottom <= item.bottom
            )
          }),
        ),
      )
      .toEqual([true, true])
    const shell = group.locator('[data-timeline-part-id="group_shell"]')
    await expect(shell.locator('[data-slot="collapsible-trigger"]')).toHaveCSS("height", "28px")
    await shell.getByRole("button").click()
    await expect(shell.locator('[data-slot="bash-command"]')).toHaveText("printf 'group geometry'")
    await expect(shell.locator('[data-slot="bash-result"]')).toHaveText("group geometry")
    await expect
      .poll(() =>
        shell.evaluate((node) => {
          const card = node.querySelector('[data-component="bash-output"]')!.getBoundingClientRect()
          const item = node.closest('[data-slot="context-tool-group-item"]')!.getBoundingClientRect()
          return card.top >= item.top && card.bottom <= item.bottom
        }),
      )
      .toBe(true)
  })
}
