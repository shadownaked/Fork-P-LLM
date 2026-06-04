import { useUIStore } from '@/store/useUIStore'

export function ToolToolbar() {
  const openOAuthModal = useUIStore((state) => state.openOAuthModal)

  return (
    <div className="toolbar">
      <button className="btn btn-primary" onClick={openOAuthModal}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        Add Tool
      </button>
    </div>
  )
}
