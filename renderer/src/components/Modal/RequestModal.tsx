import { useEffect, useState, useMemo } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { useSiteStore } from '@/store/useSiteStore'

const HTTP_METHODS = ['ALL', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const
type HttpMethod = typeof HTTP_METHODS[number]

export function RequestModal() {
  const {
    requestModal,
    closeRequestModal,
    selectRequest,
    clearAllRequests,
    useSelectedRequest
  } = useUIStore()

  const fetchSites = useSiteStore((state) => state.fetchSites)

  const { open, siteName, requests, selectedRequestId, requestDetail, loading } = requestModal
  const [searchQuery, setSearchQuery] = useState('')
  const [methodFilter, setMethodFilter] = useState<HttpMethod>('ALL')

  // Filter requests based on search query and method
  const filteredRequests = useMemo(() => {
    let result = requests

    // Filter by method
    if (methodFilter !== 'ALL') {
      result = result.filter(req => req.method.toUpperCase() === methodFilter)
    }

    // Filter by URL search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(req => req.url.toLowerCase().includes(query))
    }

    return result
  }, [requests, searchQuery, methodFilter])

  // Reset filters when modal closes
  useEffect(() => {
    if (!open) {
      setSearchQuery('')
      setMethodFilter('ALL')
    }
  }, [open])

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        closeRequestModal()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, closeRequestModal])

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      closeRequestModal()
    }
  }

  const handleUseSelected = async () => {
    const success = await useSelectedRequest()
    if (success) {
      fetchSites()
    }
  }

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString()
  }

  const getUrlPath = (url: string) => {
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  }

  if (!open) return null

  return (
    <div className="modal-overlay show" onClick={handleOverlayClick}>
      <div className="modal modal-xlarge">
        <div className="modal-header">
          <h2>Captured Requests - {siteName}</h2>
          <button className="btn-icon modal-close" onClick={closeRequestModal}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="loading-state">
              <div className="spinner"></div>
              <p>Loading requests...</p>
            </div>
          ) : requests.length === 0 ? (
            <div className="empty-requests">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
              </svg>
              <p>No requests captured yet</p>
              <span>Open the site and interact with it to capture requests</span>
            </div>
          ) : (
            <div className="request-split-view">
              {/* Left Panel - Request List */}
              <div className="request-left-panel">
                <div className="request-filter-bar">
                  <div className="request-search">
                    <input
                      type="text"
                      placeholder="Search URL..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <div className="method-filter">
                    {HTTP_METHODS.map((method) => (
                      <button
                        key={method}
                        className={`method-filter-btn ${methodFilter === method ? 'active' : ''}`}
                        onClick={() => setMethodFilter(method)}
                      >
                        {method}
                      </button>
                    ))}
                  </div>
                </div>

                {filteredRequests.length === 0 ? (
                  <div className="empty-requests">
                    <p>No matching requests</p>
                    <span>Try a different search term or filter</span>
                  </div>
                ) : (
                  <div className="request-list">
                    {filteredRequests.map((req) => (
                      <div
                        key={req.id}
                        className={`request-item ${selectedRequestId === req.id ? 'selected' : ''} ${req.isRecommended ? 'recommended' : ''}`}
                        onClick={() => selectRequest(req.id)}
                      >
                        {req.isRecommended && (
                          <span className="recommended-badge" title="Recommended - matches capture rules">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
                            </svg>
                          </span>
                        )}
                        <span className={`request-method method-${req.method.toLowerCase()}`}>
                          {req.method}
                        </span>
                        <span className="request-url">{getUrlPath(req.url)}</span>
                        <div className="request-meta">
                          {formatTime(req.timestamp)} | {req.hasBody ? 'Has Body' : 'No Body'} | {req.contentType || 'N/A'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right Panel - Request Detail */}
              <div className="request-right-panel">
                {requestDetail ? (
                  <div className="request-detail">
                    <div className="request-detail-header">
                      <span className={`request-method method-${requestDetail.method.toLowerCase()}`}>
                        {requestDetail.method}
                      </span>
                      <span className="request-url">{requestDetail.url}</span>
                    </div>
                    <div className="request-detail-content">
                      <div className="detail-section">
                        <h4>Headers</h4>
                        <pre>{JSON.stringify(requestDetail.headers, null, 2)}</pre>
                      </div>
                      <div className="detail-section">
                        <h4>Body</h4>
                        <pre>{requestDetail.body || '(empty)'}</pre>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="request-detail-empty">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="16" y1="13" x2="8" y2="13"></line>
                      <line x1="16" y1="17" x2="8" y2="17"></line>
                      <polyline points="10 9 9 9 8 9"></polyline>
                    </svg>
                    <p>Select a request to view details</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={clearAllRequests}>
            Clear All
          </button>
          <div className="footer-right">
            <button type="button" className="btn btn-ghost" onClick={closeRequestModal}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleUseSelected}
              disabled={!selectedRequestId}
            >
              Use Selected
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
