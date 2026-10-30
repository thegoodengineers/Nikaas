import React, { Suspense, lazy, useEffect, useState } from 'react'
import ExitIcon from './ExitIcon.tsx'
import Phone from './Phone.tsx'
import Sign from './Sign.tsx'
import Go from './go/Go.tsx'
import './platform/platform.css'

// the 3D simulation (three.js and its own engine) loads only when someone opens it
const Sim3D = lazy(() => import('./sim3d/Sim3D.tsx'))
// desktop pages (three.js, charts) load on demand: phones opening a QR code only get the small phone app
const Home = lazy(() => import('./Home.tsx'))
const App = lazy(() => import('./App.tsx'))
const Evidence = lazy(() => import('./Evidence.tsx'))
const Drill = lazy(() => import('./Drill.tsx'))
const Cam = lazy(() => import('./Cam.tsx'))
// app pages load on demand too, so the phone app people open from a QR code stays small
const Control = lazy(() => import('./control/Control.tsx'))
const Buildings = lazy(() => import('./plans/Buildings.tsx'))
const SiteCam = lazy(() => import('./camera/SiteCam.tsx'))
const hasSite = () => new URLSearchParams(location.hash.split('?')[1] ?? '').has('site')

// Hash routes so the site works from a plain S3 bucket with no server rewrites.
const PAGES: Record<string, { label: string; render: () => React.ReactElement; nav?: boolean; wide?: boolean }> = {
  '': { label: 'Platform', render: () => <Home />, nav: true },
  control: { label: 'Control room', render: () => <Control />, nav: true, wide: true },
  buildings: { label: 'Buildings', render: () => <Buildings />, nav: true, wide: true },
  twin: { label: 'Digital twin', render: () => <App />, nav: true },
  evidence: { label: 'Evidence', render: () => <Evidence />, nav: true },
  drill: { label: 'Live drill', render: () => <Drill /> },
}
// the header, in order: the 3D simulation is full screen (own route below) but sits in the main menu
const NAV: { href: string; route: string; label: string; feature?: boolean }[] = [
  { href: '#/', route: '', label: 'Platform' },
  { href: '#/control', route: 'control', label: 'Control room' },
  { href: '#/buildings', route: 'buildings', label: 'Buildings' },
  { href: '#/sim', route: 'sim', label: '3D simulation', feature: true },
  { href: '#/twin', route: 'twin', label: 'Digital twin' },
  { href: '#/evidence', route: 'evidence', label: 'Evidence' },
]
// demo and device tools: one menu in the header instead of footer links
const TOOLS: { href: string; route: string; label: string; note: string }[] = [
  { href: '#/drill', route: 'drill', label: 'Live drill', note: 'Presenter screen: judges scan a QR code and follow their phone' },
  { href: '#/cam?site=office', route: 'cam', label: 'Room camera', note: 'A laptop camera counts people and spots fire for the control room' },
  { href: '#/go?site=office', route: 'go', label: 'Phone app', note: 'What people see after scanning the building QR code' },
  { href: '#/sign', route: 'sign', label: 'Exit sign', note: 'A phone beside a door becomes a live exit sign' },
]
const ALIAS: Record<string, string> = {} // old links that moved
const routeOf = () => { const r = location.hash.replace(/^#\/?/, '').split('?')[0]; return ALIAS[r] ?? r }

export default function Shell() {
  const [route, setRoute] = useState(routeOf())
  useEffect(() => {
    const on = () => { setRoute(routeOf()); window.scrollTo(0, 0) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  // ?demo=1 (the video story): Home for 4 s, then the twin plays the scripted story
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('demo') || routeOf()) return
    const t = setTimeout(() => { location.hash = '#/twin' }, 4000)
    return () => clearTimeout(t)
  }, [])
  if (route === 'me') return <Phone /> // the judge's phone: no site chrome
  if (route === 'sign') return <Sign /> // a phone taped beside a door: a live exit sign
  if (route === 'cam') return <Suspense fallback={null}>{hasSite() ? <SiteCam /> : <Cam />}</Suspense> // a camera counting people (and checking for fire) in one place
  if (route === 'sim') return <Suspense fallback={<div className="page pf-muted">Loading the 3D simulation…</div>}><Sim3D /></Suspense> // full-screen, own HUD
  if (route === 'go') return <Go /> // the phone app people open from a QR code: no site chrome
  const page = PAGES[route] ?? PAGES['']
  const current = PAGES[route] ? route : ''
  return (
    <>
      <header className="nav">
        <a className="brand" href="#/"><ExitIcon color="var(--exit)" />Nikaas</a>
        <nav aria-label="Pages">
          {NAV.map(n => (
            <a key={n.href} href={n.href} className={n.feature ? 'nav-feature' : undefined} aria-current={n.route === current ? 'page' : undefined}>
              {n.feature && <span className="nav-feature-dot" aria-hidden="true" />}{n.label}
            </a>
          ))}
        </nav>
        <ToolsMenu current={current} />
      </header>
      <main className={page.wide ? 'main-wide' : undefined}><Suspense fallback={<div className="page pf-muted">Loading…</div>}>{page.render()}</Suspense></main>
      <footer className="footer">
        <p>Nikaas, built at AfterHours 1.0 (DBIT) by TheGoodEngineers, team AH50: Ayush V U, Bhumika G, Abhijeet, Chirag R H.</p>
        <p>Floor-plan photo: Biswarup Ganguly, CC BY 3.0, Wikimedia Commons. Fonts: Bricolage Grotesque, Big Shoulders Display and Atkinson Hyperlegible (SIL OFL). 3D: three.js (MIT).</p>
      </footer>
    </>
  )
}

/** Header menu for the demo and device tools. Closes on choosing, on Escape and on a click outside. */
function ToolsMenu({ current }: { current: string }) {
  const [open, setOpen] = useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const out = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('pointerdown', out); addEventListener('keydown', esc); addEventListener('hashchange', () => setOpen(false), { once: true })
    return () => { removeEventListener('pointerdown', out); removeEventListener('keydown', esc) }
  }, [open])
  const active = TOOLS.some(t => t.route === current)
  return (
    <div className="nav-tools" ref={ref}>
      <button type="button" className={`nav-tools-btn ${active ? 'is-active' : ''}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(v => !v)}>
        Tools<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="nav-tools-menu" role="menu">
          {TOOLS.map(t => (
            <a key={t.href} role="menuitem" href={t.href} onClick={() => setOpen(false)} aria-current={t.route === current ? 'page' : undefined}>
              <b>{t.label}</b><span>{t.note}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
