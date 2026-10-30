import React, { Suspense, lazy, useEffect, useState } from 'react'
import ExitIcon from './ExitIcon.tsx'
import Home from './Home.tsx'
import App from './App.tsx'
import Challenge from './Challenge.tsx'
import Evidence from './Evidence.tsx'
import Drill from './Drill.tsx'
import Phone from './Phone.tsx'
import Sign from './Sign.tsx'
import Cam from './Cam.tsx'
import Go from './go/Go.tsx'
import './platform/platform.css'

// the 3D simulation (three.js and its own engine) loads only when someone opens it
const Sim3D = lazy(() => import('./sim3d/Sim3D.tsx'))
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
  beat: { label: 'Plan challenge', render: () => <Challenge /> },
  drill: { label: 'Live drill', render: () => <Drill /> },
}
// pages linked from the footer: demos and tools that are not part of the main product flow
const MORE: [string, string][] = [['#/sim', '3D simulation'], ['#/drill', 'Live drill (presenter)'], ['#/beat', 'Plan challenge'], ['#/cam?site=office', 'Site camera'], ['#/go', 'Phone app']]
const ALIAS: Record<string, string> = { challenge: 'beat' } // old links keep working
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
  if (route === 'cam') return hasSite() ? <Suspense fallback={null}><SiteCam /></Suspense> : <Cam /> // a camera counting people (and checking for fire) in one place
  if (route === 'sim') return <Suspense fallback={<div className="page pf-muted">Loading the 3D simulation…</div>}><Sim3D /></Suspense> // full-screen, own HUD
  if (route === 'go') return <Go /> // the phone app people open from a QR code: no site chrome
  const page = PAGES[route] ?? PAGES['']
  return (
    <>
      <header className="nav">
        <a className="brand" href="#/"><ExitIcon color="var(--exit)" />Nikaas</a>
        <nav aria-label="Pages">
          {Object.entries(PAGES).filter(([, p]) => p.nav).map(([k, p]) => (
            <a key={k} href={`#/${k}`} aria-current={k === route || (!PAGES[route] && k === '') ? 'page' : undefined}>{p.label}</a>
          ))}
        </nav>
      </header>
      <main className={page.wide ? 'main-wide' : undefined}><Suspense fallback={<div className="page pf-muted">Loading…</div>}>{page.render()}</Suspense></main>
      <footer className="footer">
        <p className="footer-links">{MORE.map(([href, label]) => <a key={href} href={href}>{label}</a>)}</p>
        <p>Nikaas, built at AfterHours 1.0 (DBIT) by TheGoodEngineers, team AH50: Ayush V U, Bhumika G, Abhijeet, Chirag R H.</p>
        <p>Floor-plan photo: Biswarup Ganguly, CC BY 3.0, Wikimedia Commons. Fonts: Bricolage Grotesque, Big Shoulders Display and Atkinson Hyperlegible (SIL OFL). 3D: three.js (MIT).</p>
      </footer>
    </>
  )
}
