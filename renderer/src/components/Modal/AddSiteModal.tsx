import { useState, useEffect } from 'react'
import { useSiteStore } from '@/store/useSiteStore'
import { useUIStore } from '@/store/useUIStore'
import { generateSiteId } from '@/utils/format'

export function AddSiteModal() {
  const [targetUrl, setTargetUrl] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const addSite = useSiteStore((state) => state.addSite)
  const { addSiteModalOpen, closeAddSiteModal, showToast } = useUIStore()

  // 重置表单
  useEffect(() => {
    if (addSiteModalOpen) {
      setTargetUrl('')
      setIsSubmitting(false)
    }
  }, [addSiteModalOpen])

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && addSiteModalOpen) {
        closeAddSiteModal()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [addSiteModalOpen, closeAddSiteModal])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!targetUrl.trim()) {
      showToast('Please enter a URL', 'error')
      return
    }

    // 验证 URL
    let url: URL
    try {
      url = new URL(targetUrl)
    } catch {
      showToast('Invalid URL format', 'error')
      return
    }

    setIsSubmitting(true)

    // 从 URL 提取名称
    const name = url.hostname.replace(/^www\./, '').split('.')[0]
    const id = generateSiteId(name)

    const success = await addSite({
      id,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      targetUrl: url.origin,
      enabled: true,
      captureRules: [{
        urlPattern: '*',
        captureAuth: true,
        captureSessionId: true
      }],
      adapterType: 'generic'
    })

    setIsSubmitting(false)

    if (success) {
      showToast('Site added successfully!')
      closeAddSiteModal()
    } else {
      showToast('Failed to add site', 'error')
    }
  }

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      closeAddSiteModal()
    }
  }

  if (!addSiteModalOpen) return null

  return (
    <div className="modal-overlay show" onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <h2>Add New Site</h2>
          <button className="btn-icon modal-close" onClick={closeAddSiteModal}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="targetUrl">Target URL</label>
              <input
                type="url"
                id="targetUrl"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://example.com"
                required
                autoFocus
              />
              <span className="form-hint">Enter the base URL of the LLM service</span>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={closeAddSiteModal}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Adding...' : 'Add Site'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
