const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})

const plain = new Intl.NumberFormat("en-US")

const oneDecimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

/** Compact token count, e.g. 1234567 → "1.2M". */
export function formatTokens(value: number): string {
  return value < 10_000 ? plain.format(value) : compact.format(value)
}

export function formatCost(value: number): string {
  return usd.format(value)
}

export function formatCount(value: number): string {
  return plain.format(value)
}

/** 0..1 rate with the precision used by metric tables. */
export function formatRate(rate: number): string {
  return `${oneDecimal.format(rate * 100)}%`
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function formatRelative(timestamp: number): string {
  const delta = Date.now() - timestamp
  if (delta < 60_000) return "just now"
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  const days = Math.floor(delta / 86_400_000)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

/** 0..1 share → "42%". */
export function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`
}
