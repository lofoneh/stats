import { createFileRoute } from "@tanstack/react-router"

import { parseStatsSearch } from "@/components/data/api"
import { BreakdownPage } from "@/components/breakdown-page"

export const Route = createFileRoute("/projects")({
  validateSearch: parseStatsSearch,
  component: ProjectsPage,
})

function ProjectsPage() {
  return (
    <BreakdownPage
      filter={Route.useSearch()}
      dimension="project"
      title="Projects"
      nameLabel="Project/Folder"
      resultLabel="projects"
    />
  )
}
