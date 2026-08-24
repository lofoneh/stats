// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { BreakdownRow } from "@/lib/api/types"
import { BreakdownTable } from "@/components/breakdown-table"

const row: BreakdownRow = {
  key: "/work/project",
  label: "/work/project",
  tokens: {
    input: 200,
    output: 100,
    cacheRead: 400,
    cacheWrite: 0,
    reasoning: 0,
    total: 700,
  },
  pricedCostUsd: 1.25,
  unpricedEventCount: 1,
  events: 2,
  sessions: 1,
  firstTimestamp: Date.UTC(2026, 7, 1),
  lastTimestamp: Date.UTC(2026, 7, 2),
  tokenShare: 1,
  cacheReadShare: 2 / 3,
  hasEstimatedTokens: false,
}

describe("BreakdownTable", () => {
  afterEach(cleanup)

  it("shows only project metrics backed by normalized usage data", () => {
    render(
      <BreakdownTable
        rows={[row]}
        dimension="project"
        nameLabel="Project/Folder"
      />
    )

    for (const name of [
      "Project/Folder",
      "Requests",
      "Cost",
      "Tokens",
      "Cache rate",
    ]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy()
    }
    expect(
      screen.queryByRole("columnheader", { name: "Cache savings" })
    ).toBeNull()
    expect(
      screen.queryByRole("columnheader", { name: "Error rate" })
    ).toBeNull()
    expect(
      screen.queryByRole("columnheader", { name: "Avg duration" })
    ).toBeNull()
    expect(screen.getByText("66.7%")).toBeTruthy()
    expect(screen.queryByText(/unpriced/)).toBeNull()
  })
})
