import { useSiteStore } from '@/store/useSiteStore'
import { useUIStore } from '@/store/useUIStore'

export function Toolbar() {
  const fetchSites = useSiteStore((state) => state.fetchSites)
  const openAddSiteModal = useUIStore((state) => state.openAddSiteModal)

  return (
    <div className="toolbar">
      <button className="btn btn-primary" onClick={openAddSiteModal}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        Add Site
      </button>
      <button className="btn btn-ghost" onClick={fetchSites}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        Refresh All
      </button>
    </div>
  )
}
