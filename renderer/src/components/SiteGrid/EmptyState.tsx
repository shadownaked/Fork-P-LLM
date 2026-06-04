import { useUIStore } from '@/store/useUIStore'

export function EmptyState() {
  const openAddSiteModal = useUIStore((state) => state.openAddSiteModal)

  return (
    <div className="empty-state">
      <div className="empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="3" y1="9" x2="21" y2="9"></line>
          <line x1="9" y1="21" x2="9" y2="9"></line>
        </svg>
      </div>
      <h3>No sites configured</h3>
      <p>Add your first LLM site to start proxying requests</p>
      <button className="btn btn-primary" onClick={openAddSiteModal}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        Add Your First Site
      </button>
    </div>
  )
}
