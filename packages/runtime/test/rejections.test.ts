import { expect, test } from "bun:test"

import { runtimeConfig } from "../src/app.ts"
import { recordHistory } from "../src/features/testing/record-history/impl.ts"
import { rejectionCodes } from "../src/rejections.ts"

test("the host's rejection codes are exactly those the Commands' Scenarios name", () => {
  const named = new Set(
    [...Object.values(runtimeConfig.slices), recordHistory].flatMap((slice) =>
      slice.kind === "command"
        ? slice.scenarios.flatMap((scenario) => (scenario.reject === undefined ? [] : [scenario.reject.code]))
        : [],
    ),
  )
  expect([...named].toSorted()).toEqual([...rejectionCodes].toSorted())
})
