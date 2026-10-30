// Where the building comes from: #/sim (the demo block), #/sim?site=<id> (GET ${API}/sites/<id>) or
// #/sim?file=data/x.json (a file served next to the site, with bundled copies of the examples as a fallback).
import { demoPlan, type Plan } from './plan.ts'
import { graphPlan, type Building, type SiteDoc } from './graph.ts'

export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
export type Source = { kind: 'demo' } | { kind: 'site'; id: string } | { kind: 'file'; path: string }
export type SiteItem = { id: string; name: string; floors?: number; people?: number }

export function sourceFromHash(hash = location.hash): Source {
  const q = new URLSearchParams(hash.split('?')[1] ?? '')
  const site = q.get('site'), file = q.get('file')
  if (site) return { kind: 'site', id: site }
  if (file) return { kind: 'file', path: file }
  return { kind: 'demo' }
}
export const sourceKey = (s: Source) => (s.kind === 'demo' ? 'demo' : s.kind === 'site' ? `site:${s.id}` : `file:${s.path}`)
export const sourceHash = (s: Source) => (s.kind === 'demo' ? '#/sim' : s.kind === 'site' ? `#/sim?site=${encodeURIComponent(s.id)}` : `#/sim?file=${encodeURIComponent(s.path)}`)
export function parseKey(k: string): Source {
  if (k.startsWith('site:')) return { kind: 'site', id: k.slice(5) }
  if (k.startsWith('file:')) return { kind: 'file', path: k.slice(5) }
  return { kind: 'demo' }
}

/** Example buildings shipped with the app, used when no API answers. */
export const BUNDLED_FILES: { path: string; label: string }[] = [
  { path: 'data/multi_floor_office.json', label: 'Office, 3 floors' },
  { path: 'data/multi_floor_tower.json', label: 'Tower, 5 floors' },
  { path: 'data/iit_kgp_museum.json', label: 'Science museum, IIT Kharagpur' },
]
const BUNDLED = import.meta.glob('./data/*.json', { import: 'default' }) as Record<string, () => Promise<unknown>>

// relative paths on this site only: no other hosts, no climbing out of the site root
const safePath = (p: string) => /^[\w\-./]+\.json$/.test(p) && !p.includes('..') && !p.startsWith('/')

async function fetchJson(url: string, ms = 8000): Promise<unknown> {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms)
  try {
    const r = await fetch(url, { signal: c.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const text = await r.text()
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) // tolerate a byte-order mark
  } finally { clearTimeout(t) }
}
const isBuilding = (d: unknown): d is Building | SiteDoc => !!d && typeof d === 'object' && ('nodes' in d || 'building' in d)

export async function loadPlan(s: Source): Promise<Plan> {
  if (s.kind === 'demo') return demoPlan()
  if (s.kind === 'site') {
    if (!API) throw new Error('No API is configured for this site, so saved sites cannot be loaded.')
    let doc: unknown
    try { doc = await fetchJson(`${API}/sites/${encodeURIComponent(s.id)}`) } catch (e) { throw new Error(`Could not load the site "${s.id}" (${e instanceof Error ? e.message : 'network error'}).`) }
    if (!isBuilding(doc)) throw new Error(`The site "${s.id}" has no building plan.`)
    return graphPlan(doc, sourceKey(s))
  }
  if (!safePath(s.path)) throw new Error('Only .json building files on this site can be opened.')
  let doc: unknown = null
  try { doc = await fetchJson(s.path) } catch { /* not served here: fall back to the bundled copy */ }
  if (!isBuilding(doc)) {
    const load = BUNDLED[`./data/${s.path.split('/').pop()}`]
    if (!load) throw new Error(`Could not load ${s.path}.`)
    doc = await load()
  }
  if (!isBuilding(doc)) throw new Error(`${s.path} is not a building graph.`)
  return graphPlan(doc, sourceKey(s))
}

export async function listSites(): Promise<SiteItem[]> {
  if (!API) return []
  const list = await fetchJson(`${API}/sites`, 5000)
  if (!Array.isArray(list)) return []
  return list.filter(x => x && typeof x.id === 'string').map(x => ({
    id: x.id, name: String(x.name || x.id),
    floors: Array.isArray(x.floors) ? x.floors.length : typeof x.floors === 'number' ? x.floors : undefined,
    people: typeof x.people === 'number' ? x.people : undefined,
  }))
}
