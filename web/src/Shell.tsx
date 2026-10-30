import React, { useEffect, useState } from 'react'
import ExitIcon from './ExitIcon.tsx'
import Home from './Home.tsx'
import App from './App.tsx'
import Challenge from './Challenge.tsx'
import Evidence from './Evidence.tsx'
import Drill from './Drill.tsx'
import Sim3D from './sim3d/Sim3D.tsx'
import Phone from './Phone.tsx'
import Sign from './Sign.tsx'

// Hash routes so the site works from a plain S3 bucket with no server rewrites.
const PAGES: Record<string, { label: string; render: () => React.ReactElement }> = {
  '': { label: 'Home', render: () => <Home /> },
  twin: { label: 'Twin', render: () => <App /> },
  sim: { label: '3D Sim', render: () => <Sim3D /> },
  beat: { label: 'Beat Nikaas', render: () => <Challenge /> },
  drill: { label: 'Live drill', render: () => <Drill /> },
  evidence: { label: 'Evidence', render: () => <Evidence /> },
}
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
  if (route === 'sim') return <Sim3D /> // full-screen 3D evacuation game with its own HUD
  const page = PAGES[route] ?? PAGES['']
  return (
    <>
      <header className="nav">
        <a className="brand" href="#/"><ExitIcon color="var(--exit)" />Nikaas</a>
        <nav aria-label="Pages">
          {Object.entries(PAGES).map(([k, p]) => (
            <a key={k} href={`#/${k}`} aria-current={k === route ? 'page' : undefined}>{p.label}</a>
          ))}
        </nav>
      </header>
      <main>{page.render()}</main>
      <footer className="footer">
        <p>Nikaas, built at AfterHours 1.0 (DBIT) by TheGoodEngineers, team AH50: Ayush V U, Bhumika G, Abhijeet, Chirag R H.</p>
        <p>Floor-plan photo: Biswarup Ganguly, CC BY 3.0, Wikimedia Commons. Fonts: Bricolage Grotesque, Big Shoulders Display and Atkinson Hyperlegible (SIL OFL). 3D: three.js (MIT).</p>
      </footer>
    </>
  )
}
