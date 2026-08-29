import { join } from "node:path"
import type { AgentId } from "../../registry"
import type {
  AgentAdapter,
  DiscoveryContext,
  ParseContext,
  ParseOutput,
  UsageSource,
} from "../../types"
import { walkFiles } from "../../../usage/parse"

interface FileAdapterOptions {
  id: AgentId
  label: string
  version?: number
  roots: (context: DiscoveryContext) => string[]
  file: (name: string) => boolean
  kind?: string
  parse: (source: UsageSource, context: ParseContext) => Promise<ParseOutput>
}

export function fileAdapter(options: FileAdapterOptions): AgentAdapter {
  return {
    id: options.id,
    label: options.label,
    version: options.version ?? 1,
    async *discover(context) {
      const paths = new Set<string>()
      for (const root of options.roots(context)) {
        for (const path of await walkFiles(root, options.file)) paths.add(path)
      }
      for (const root of context.extraRoots) {
        for (const path of await walkFiles(
          join(root, options.id),
          options.file
        ))
          paths.add(path)
      }
      for (const path of paths)
        yield { agent: options.id, path, kind: options.kind ?? "jsonl" }
    },
    parse: options.parse,
  }
}
