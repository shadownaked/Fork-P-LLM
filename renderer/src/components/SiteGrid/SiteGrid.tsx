import { useSiteStore } from '@/store/useSiteStore'
import { SiteCard } from './SiteCard'
import { EmptyState } from './EmptyState'
import { ToolToolbar } from '@/components/ToolToolbar'
import { ToolGrid } from '@/components/ToolGrid'

export function SiteGrid() {
  const { sites, loading } = useSiteStore()

  if (loading && sites.length === 0) {
    return (
      <main className="main-content">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading sites...</p>
        </div>
        <ToolToolbar />
        <ToolGrid />
      </main>
    )
  }

  if (sites.length === 0) {
    return (
      <main className="main-content">
        <EmptyState />
        <ToolToolbar />
        <ToolGrid />
      </main>
    )
  }

  return (
    <main className="main-content">
      <div className="site-grid">
        {sites.map((site) => (
          <SiteCard key={site.id} site={site} />
        ))}
      </div>
      <ToolToolbar />
      <ToolGrid />
    </main>
  )
}
