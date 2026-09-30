// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
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
    expect(screen.getByText("+1 unpriced")).toBeTruthy()
  })

  it.each([
    { pricedCostUsd: 0, unpricedEventCount: 2, expected: "unpriced" },
    {
      pricedCostUsd: 1.25,
      unpricedEventCount: 1,
      expected: "$1.25 +1 unpriced",
    },
    { pricedCostUsd: 1.25, unpricedEventCount: 0, expected: "$1.25" },
    { pricedCostUsd: 0, unpricedEventCount: 0, expected: "$0.00" },
  ])(
    "preserves project pricing completeness: $expected",
    ({ expected, ...pricing }) => {
      render(
        <BreakdownTable
          rows={[{ ...row, ...pricing }]}
          dimension="project"
          nameLabel="Project/Folder"
        />
      )

      const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell")
      expect(cells[2].textContent).toBe(expected)
    }
  )

  it("renders and paginates a project list larger than the argument limit", () => {
    const rows = Array.from({ length: 150_000 }, (_, index) => ({
      ...row,
      key: `/work/project-${index}`,
      label: `/work/project-${index}`,
      events: index === 149_999 ? 4 : 2,
      pricedCostUsd: index === 149_999 ? 5 : 1.25,
      unpricedEventCount: 0,
    }))
    render(
      <BreakdownTable
        rows={rows}
        dimension="project"
        nameLabel="Project/Folder"
      />
    )

    expect(screen.getAllByRole("row")).toHaveLength(11)
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell")
    expect(cells[1].querySelector<HTMLElement>("[style]")?.style.width).toBe(
      "50%"
    )
    expect(cells[2].querySelector<HTMLElement>("[style]")?.style.width).toBe(
      "25%"
    )

    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByText("/work/project-10")).toBeTruthy()
    expect(screen.queryByText("/work/project-0")).toBeNull()
  }, 20_000)
})
