import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './fonts.css'
import './theme.css'
import Shell from './Shell.tsx'

// A tab left open across a deploy still runs the old build; when it opens another page it asks for that page's
// old file, which the new build replaced. Load the new build instead of showing a blank page (at most once a
// minute, so a real network problem cannot cause a reload loop).
function reloadForNewBuild() {
  try {
    const last = Number(sessionStorage.getItem('nikaas-reloaded') ?? 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem('nikaas-reloaded', String(Date.now()))
  } catch { /* private mode: reload anyway */ }
  location.reload()
}
const stale = (m: unknown) => /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(String(m))
addEventListener('vite:preloadError', e => { e.preventDefault(); reloadForNewBuild() })
addEventListener('unhandledrejection', e => { if (stale(e.reason?.message ?? e.reason)) reloadForNewBuild() })
addEventListener('error', e => { if (stale(e.message)) reloadForNewBuild() })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
)
