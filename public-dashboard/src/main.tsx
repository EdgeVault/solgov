import { StrictMode, Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Shows a short message instead of a blank page if rendering throws (for example on an unexpected
// API response), and logs the error for debugging.
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('solgov dashboard render error', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="min-h-screen bg-[#08080d] text-gray-300 flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-white mb-2">solgov could not display this page</h1>
          <p className="text-sm text-gray-400 mb-4">Something in the data could not be rendered. Reloading usually fixes it. The raw data remains available through the API.</p>
          <div className="flex gap-3 justify-center text-sm">
            <button type="button" onClick={() => window.location.reload()} className="px-3 py-1.5 border border-white/[0.15] rounded-md hover:border-white/[0.3]">Reload</button>
            <a href="/api-docs.html" className="px-3 py-1.5 border border-white/[0.15] rounded-md hover:border-white/[0.3]">API reference</a>
          </div>
        </div>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
