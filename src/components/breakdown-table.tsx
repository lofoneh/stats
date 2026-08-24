import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import type {
  ColumnDef,
  PaginationState,
  SortingState,
} from "@tanstack/react-table"
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon } from "lucide-react"

import type { BreakdownDimension, BreakdownRow } from "@/lib/api/types"
import {
  formatCost,
  formatCount,
  formatRate,
  formatRelative,
  formatShare,
  formatTokens,
} from "@/components/data/format"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    numeric?: boolean
  }
}

const PER_PAGE = 10

/**
 * Breakdown data grid: @tanstack/react-table sorting + pagination inside a
 * rounded card with a muted header band.
 */
export function BreakdownTable({
  rows,
  dimension,
  nameLabel,
  resultLabel,
  onSelect,
}: {
  rows: BreakdownRow[]
  dimension: BreakdownDimension
  nameLabel: string
  resultLabel?: string
  /** Row click — filter by this row's key. "(unknown)" rows never fire. */
  onSelect?: (key: string) => void
}) {
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "tokens", desc: true },
  ])
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize: PER_PAGE,
  })

  const columns = React.useMemo<ColumnDef<BreakdownRow>[]>(() => {
    const labelColumn: ColumnDef<BreakdownRow> = {
      id: "label",
      accessorFn: (row) => row.label.toLowerCase(),
      header: nameLabel,
      cell: ({ row }) => (
        <span className="block max-w-64 truncate font-medium">
          {row.original.label}
          {row.original.hasEstimatedTokens ? (
            <span
              className="font-normal text-muted-foreground"
              title="Includes estimated tokens"
            >
              {" "}
              est.
            </span>
          ) : null}
        </span>
      ),
    }

    if (dimension === "project") {
      const maxRequests = Math.max(...rows.map((row) => row.events), 0)
      const maxCost = Math.max(...rows.map((row) => row.pricedCostUsd), 0)
      return [
        labelColumn,
        {
          id: "requests",
          accessorFn: (row) => row.events,
          header: "Requests",
          meta: { numeric: true },
          cell: ({ row }) => (
            <RelativeMetricCell
              value={row.original.events}
              max={maxRequests}
              tone="requests"
            >
              {formatCount(row.original.events)}
            </RelativeMetricCell>
          ),
        },
        {
          id: "cost",
          accessorFn: (row) => row.pricedCostUsd,
          header: "Cost",
          meta: { numeric: true },
          cell: ({ row }) => (
            <RelativeMetricCell
              value={row.original.pricedCostUsd}
              max={maxCost}
              tone="cost"
            >
              <CostCell row={row.original} showUnpriced={false} />
            </RelativeMetricCell>
          ),
        },
        {
          id: "tokens",
          accessorFn: (row) => row.tokens.total,
          header: "Tokens",
          meta: { numeric: true },
          cell: ({ row }) => <TokensCell row={row.original} />,
        },
        {
          id: "cacheRate",
          accessorFn: (row) => row.cacheReadShare,
          header: "Cache rate",
          meta: { numeric: true },
          cell: ({ row }) => (
            <span title="Cache reads as a share of input and cache-read tokens">
              {formatRate(row.original.cacheReadShare)}
            </span>
          ),
        },
      ]
    }

    return [
      labelColumn,
      {
        id: "tokens",
        accessorFn: (row) => row.tokens.total,
        header: "Tokens",
        meta: { numeric: true },
        cell: ({ row }) => <TokensCell row={row.original} />,
      },
      {
        id: "cost",
        accessorFn: (row) => row.pricedCostUsd,
        header: "Cost",
        meta: { numeric: true },
        cell: ({ row }) => <CostCell row={row.original} />,
      },
      {
        id: "sessions",
        accessorFn: (row) => row.sessions,
        header: "Sessions",
        meta: { numeric: true },
        cell: ({ row }) => formatCount(row.original.sessions),
      },
      {
        id: "last",
        accessorFn: (row) => row.lastTimestamp,
        header: "Last active",
        meta: { numeric: true },
        cell: ({ row }) => (
          <span
            className="text-muted-foreground"
            title={new Date(row.original.firstTimestamp).toLocaleString()}
          >
            {formatRelative(row.original.lastTimestamp)}
          </span>
        ),
      },
      {
        id: "share",
        enableSorting: false,
        header: "Share",
        cell: ({ row }) => <ShareBar share={row.original.tokenShare} />,
      },
    ]
  }, [dimension, nameLabel, rows])

  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (row) => row.key,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })

  const headers = table.getHeaderGroups()[0].headers
  const totalPages = table.getPageCount()

  return (
    <section
      className={cn(
        "flex w-full flex-col rounded-2xl border pt-2",
        totalPages > 1 ? "pb-3" : "pb-0"
      )}
    >
      <div className="flex flex-col justify-center px-3 py-1">
        <p className="text-[13px] whitespace-nowrap text-muted-foreground">
          Total results
        </p>
        <p className="text-sm font-medium whitespace-nowrap">
          {formatCount(rows.length)}{" "}
          {resultLabel ?? `${nameLabel.toLowerCase()}s`}
        </p>
      </div>

      <div className="mt-2 w-full overflow-x-auto">
        <table
          className={cn(
            "w-full border-collapse text-left",
            dimension === "project" ? "min-w-[700px]" : "min-w-[640px]"
          )}
        >
          <thead>
            <tr>
              {headers.map((header) => {
                const canSort = header.column.getCanSort()
                const numeric = header.column.columnDef.meta?.numeric
                const dir = header.column.getIsSorted()
                const label = flexRender(
                  header.column.columnDef.header,
                  header.getContext()
                )
                return (
                  <th
                    key={header.id}
                    aria-sort={
                      dir === "desc"
                        ? "descending"
                        : dir === "asc"
                          ? "ascending"
                          : "none"
                    }
                    className={cn(
                      "border-y bg-muted px-3 py-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground",
                      numeric && "text-right"
                    )}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex cursor-pointer items-center gap-0.5 rounded-sm align-middle hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {label}
                        <SortChevron dir={dir} />
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const selectable = onSelect && row.original.key !== "(unknown)"
              return (
                <tr
                  key={row.id}
                  onClick={
                    selectable ? () => onSelect(row.original.key) : undefined
                  }
                  title={
                    selectable ? `Filter by ${row.original.label}` : undefined
                  }
                  className={cn(
                    "border-b transition-colors duration-150 hover:bg-muted/50",
                    selectable && "cursor-pointer",
                    totalPages <= 1 && "last:border-transparent"
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={cn(
                        "px-3 py-2.5 align-middle text-sm whitespace-nowrap",
                        cell.column.columnDef.meta?.numeric &&
                          "text-right font-mono text-[13px] tabular-nums",
                        cell.column.id === "share" && "w-32"
                      )}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <Pagination
          className="px-3 pt-3"
          page={pagination.pageIndex + 1}
          totalPages={totalPages}
          onChange={(p) => table.setPageIndex(p - 1)}
        />
      ) : null}
    </section>
  )
}

function SortChevron({ dir }: { dir: false | "asc" | "desc" }) {
  return (
    <ChevronDownIcon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 transition-[transform,color] duration-150",
        dir === "asc" && "rotate-180",
        dir ? "text-foreground" : "text-muted-foreground"
      )}
    />
  )
}

const DOTS = "dots"

function paginationRange(
  current: number,
  total: number
): (number | typeof DOTS)[] {
  // first + last + current + 2 siblings + 2 dots
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)

  const leftSibling = Math.max(current - 1, 1)
  const rightSibling = Math.min(current + 1, total)
  const showLeftDots = leftSibling > 2
  const showRightDots = rightSibling < total - 2

  if (!showLeftDots && showRightDots) return [1, 2, 3, 4, 5, DOTS, total]
  if (showLeftDots && !showRightDots)
    return [1, DOTS, total - 4, total - 3, total - 2, total - 1, total]
  return [1, DOTS, leftSibling, current, rightSibling, DOTS, total]
}

// No transition on the cells: animating background/shadow makes the
// previously-active number visibly fade out on every page change.
const cell =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-sm"

/** Previous/Next buttons around a windowed page list. */
function Pagination({
  page,
  totalPages,
  onChange,
  className,
}: {
  page: number
  totalPages: number
  onChange: (page: number) => void
  className?: string
}) {
  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex w-full items-center justify-between gap-2",
        className
      )}
    >
      <Button
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        <ArrowLeftIcon data-icon="inline-start" aria-hidden />
        <span className="max-sm:sr-only">Previous</span>
      </Button>

      <ul className="flex min-w-0 items-center gap-0.5">
        {paginationRange(page, totalPages).map((item, i) =>
          item === DOTS ? (
            <li
              key={`dots-${i}`}
              aria-hidden
              className={cn(cell, "text-muted-foreground")}
            >
              …
            </li>
          ) : (
            <li key={item}>
              <button
                type="button"
                aria-label={`Go to page ${item}`}
                aria-current={item === page ? "page" : undefined}
                onClick={() => onChange(item)}
                className={cn(
                  cell,
                  "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  item === page
                    ? "border bg-background font-medium shadow-xs"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {item}
              </button>
            </li>
          )
        )}
      </ul>

      <Button
        variant="outline"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        <span className="max-sm:sr-only">Next</span>
        <ArrowRightIcon data-icon="inline-end" aria-hidden />
      </Button>
    </nav>
  )
}

function TokensCell({ row }: { row: BreakdownRow }) {
  const detail = `in ${formatTokens(row.tokens.input)} · out ${formatTokens(row.tokens.output)} · cache ${formatTokens(row.tokens.cacheRead + row.tokens.cacheWrite)}`
  return <span title={detail}>{formatTokens(row.tokens.total)}</span>
}

function CostCell({
  row,
  showUnpriced = true,
}: {
  row: BreakdownRow
  showUnpriced?: boolean
}) {
  if (
    showUnpriced &&
    row.pricedCostUsd === 0 &&
    row.unpricedEventCount === row.events
  ) {
    return <span className="text-muted-foreground">unpriced</span>
  }
  return (
    <span>
      {formatCost(row.pricedCostUsd)}
      {showUnpriced && row.unpricedEventCount > 0 ? (
        <span className="text-muted-foreground">
          {" "}
          +{formatCount(row.unpricedEventCount)} unpriced
        </span>
      ) : null}
    </span>
  )
}

function RelativeMetricCell({
  children,
  value,
  max,
  tone,
}: {
  children: React.ReactNode
  value: number
  max: number
  tone: "requests" | "cost"
}) {
  const width = max > 0 ? (value / max) * 100 : 0
  return (
    <span className="flex flex-col items-end gap-1">
      <span>{children}</span>
      <span
        aria-hidden="true"
        className="block h-1 w-24 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            "block h-full rounded-full",
            tone === "requests" ? "bg-chart-1" : "bg-chart-4"
          )}
          style={{ width: `${width}%` }}
        />
      </span>
    </span>
  )
}

function ShareBar({ share }: { share: number }) {
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`${formatShare(share)} of tokens`}
    >
      <div
        className="h-full rounded-full bg-chart-1"
        style={{ width: `${Math.max(share * 100, 1)}%` }}
      />
    </div>
  )
}
