import { useNavigate } from "@tanstack/react-router"

import type {
  BreakdownDimension,
  BreakdownRow,
  StatsFilter,
} from "@/lib/api/types"
import { getJson, statsUrl } from "@/components/data/api"
import { usePoll } from "@/components/data/use-poll"
import { BreakdownTable } from "@/components/breakdown-table"
import { EmptyState, ErrorState, PageSkeleton } from "@/components/states"

/** Which filter list a clicked row's key belongs to. */
const FILTER_KEY: Partial<
  Record<BreakdownDimension, "agents" | "models" | "projects">
> = {
  agent: "agents",
  model: "models",
  project: "projects",
}

export function BreakdownPage({
  filter,
  dimension,
  title,
  nameLabel,
  resultLabel,
}: {
  filter: StatsFilter
  dimension: BreakdownDimension
  title: string
  nameLabel: string
  resultLabel?: string
}) {
  const navigate = useNavigate()
  const poll = usePoll(
    () => getJson<BreakdownRow[]>(statsUrl("breakdown", filter, { dimension })),
    `${dimension}:${JSON.stringify(filter)}`
  )

  if (poll.error)
    return <ErrorState message={poll.error} onRetry={poll.refresh} />
  if (poll.loading || !poll.data) return <PageSkeleton />

  if (poll.data.length === 0) {
    return (
      <EmptyState
        filtered={(filter.agents?.length ?? 0) > 0 || filter.range !== "all"}
      />
    )
  }

  const filterKey = FILTER_KEY[dimension]
  const select = filterKey
    ? (key: string) => {
        void navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => {
            const current = (prev[filterKey] as string[] | undefined) ?? []
            if (current.includes(key)) return prev
            return { ...prev, [filterKey]: [...current, key] }
          },
        })
      }
    : undefined

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-[13px] text-muted-foreground">
          Token usage by {dimension} in the selected range
          {select ? " — click a row to filter" : ""}
        </p>
      </div>
      <BreakdownTable
        rows={poll.data}
        dimension={dimension}
        nameLabel={nameLabel}
        resultLabel={resultLabel}
        onSelect={select}
      />
    </div>
  )
}
