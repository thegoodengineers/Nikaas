// Client for the platform API (docs/PLATFORM.md): sites, check-in, alerts, control room.
export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

export type MapNode = [string, string, number, number, number, number, string | null] // id, type, x, z, w, d, floor
export type MapEdge = [string, string, string] // from, to, kind
export type Floor = { id: string; name: string; elevation_m?: number }
export type Step = { kind: 'start' | 'walk' | 'turn' | 'stairs' | 'exit' | 'outside' | 'refuge'; text: string; floor: string | null; node: string | null; distance_m: number }
export type Assembly = { id: string; label: string; lat: number | null; lng: number | null; x?: number; z?: number; exits?: string[] }
export type Route = {
  mode: 'exit' | 'refuge' | 'stay'; exit: string | null; exit_label: string | null; group: string | null; group_color: string | null
  distance_m: number; walk_s: number; wave: number; release_at: number; path: string[]; steps: Step[]; assembly: Assembly | null; changed: boolean
}
export type Alarm = { id: string; type: string; message: string; started_at: number; origin: string | null; version: number; phased: boolean; wave_gap_s: number }
export type Hazard = { id: string; kind: string; node: string; floor: string | null; label: string; source?: string; confidence?: number | null; at?: number }
export type Person = {
  token: string; room: string | null; room_label: string | null; floor: string | null; gate: string | null; status: 'inside' | 'safe' | 'help'
  need: string | null; checked_in_at: number; updated_at: number; safe_verified: boolean | null; safe_distance_m?: number | null; push: boolean; seen: number
  phone: string | null; phone_verified: boolean; verify_pending: boolean
}
export type Me = {
  site: { id: string; name: string; floors: Floor[]; rooms: [string, string, string | null][]; exits: [string, string][] }
  person: Person; alarm: Alarm | null; route: Route | null; hazards: Hazard[]; map: { nodes: MapNode[]; edges: MapEdge[] }; version: number
}
export type SiteSummary = { id: string; name: string; address: string; demo: boolean; floors: number; rooms: number; exits: number; people: number; geo: Geo | null }
export type Geo = { lat: number; lng: number; rotation_deg: number }
export type BuildingNode = { id: string; type: 'room' | 'corridor' | 'exit'; x: number; z: number; w?: number; d?: number; people?: number; label?: string; floor_id?: string; stair?: boolean; [k: string]: unknown }
export type BuildingEdge = { from: string; to: string; width: number; length?: number; kind?: 'door' | 'corridor' | 'stair'; capacity_group?: string }
export type Building = { name: string; floors?: { id: string; name: string; elevation_m: number }[]; nodes: BuildingNode[]; edges: BuildingEdge[]; [k: string]: unknown }
export type Site = { id: string; name: string; address?: string; demo?: boolean; building: Building; geo: Geo | null; assembly: Assembly[]; updated_at?: number; media?: import('./walls.ts').Media }
export type Level = 'ok' | 'concern' | 'crush'
export type ControlPerson = {
  token: string; room: string | null; room_label: string | null; floor: string | null; status: 'inside' | 'safe' | 'help'; need: string | null
  updated_at: number; exit: string | null; group: string | null; safe_verified: boolean | null; safe_distance_m: number | null; push: boolean
  phone: string | null; phone_verified: boolean; sms_last: { kind: string; ok: boolean; error: string | null; at: number } | null
}
export type Control = {
  site: SiteSummary & { building: Building; assembly: Assembly[] }
  alarm: (Alarm & { groups: Record<string, { letter: string; color: string }>; waves: Record<string, number>; time_s: number | null; method: string; trapped: string[]; changed: string[] }) | null
  counts: { checked_in: number; inside: number; safe: number; help: number; missing: number }
  floors: { id: string | null; name: string; inside: number; safe: number; help: number; wave: number }[]
  rooms: Record<string, { label: string; floor: string | null; people: number; planned: number; camera: number | null; area_m2: number; density: number; level: Level; exit: string | null; group: string | null; trapped: boolean }>
  spots: { node: string; label: string; people: number; area_m2: number; density: number; level: Level }[]
  people: ControlPerson[]; help: ControlPerson[]; missing: ControlPerson[]
  hazards: Hazard[]
  exits: { id: string; label: string; group: string | null; color: string | null; planned: number; assigned: number; out: number; eta_s: number | null; rooms: string[]; room_labels: string[]; blocked: boolean }[]
  waves: { wave: number; floors: string[]; release_at: number }[]
  sensors: { sensor_id: string; node: string; temp_c: number | null; smoke: number | null; at: number }[]
  cameras: { camera_id: string; node: string; people: number | null; fire: number; smoke: number; at: number; confirmed: boolean | null }[]
  events: { at: number; kind: 'info' | 'warn' | 'danger' | 'good'; text: string }[]
  version: number
  thresholds: { concern: number; crush: number; heat_c: number }
  server_time?: number
  push?: { on: number; total: number }; sms?: { provider: string; sandbox: boolean | null; registered: number; verified: number; sandbox_limit: number | null; last: { kind: string; sent: number; failed: number; at: number } | null }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

const store = {
  get(k: string) { try { return localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ } },
}

/** This phone's anonymous id: random, made once, never tied to a name. */
export function token(): string {
  let t = store.get('nikaas-token')
  if (!t) {
    t = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).replace(/[^A-Za-z0-9-]/g, '')
    store.set('nikaas-token', t)
  }
  return t
}
export const controlKey = () => store.get('nikaas-control-key') ?? ''
export const setControlKey = (k: string | null) => store.set('nikaas-control-key', k)
export const saved = store

async function call<T>(method: string, path: string, body?: unknown, control = false): Promise<T> {
  if (!API) throw new ApiError(0, 'This page needs the live API (VITE_API_URL is not set).')
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (control && controlKey()) headers['x-control-key'] = controlKey()
  let r: Response
  try {
    r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError(0, 'No connection to the server.')
  }
  if (!r.ok) {
    let msg = `Server error ${r.status}`
    try { const j = await r.json(); if (j?.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail) } catch { /* not JSON */ }
    throw new ApiError(r.status, msg)
  }
  return r.json() as Promise<T>
}
export const api = {
  get: <T>(path: string, control = false) => call<T>('GET', path, undefined, control),
  post: <T>(path: string, body: unknown, control = false) => call<T>('POST', path, body, control),
  del: <T>(path: string, control = false) => call<T>('DELETE', path, undefined, control),
}

/** Query string after the hash route: #/go?site=office&room=r1 */
export function hashQuery(): URLSearchParams {
  const h = location.hash
  const i = h.indexOf('?')
  return new URLSearchParams(i >= 0 ? h.slice(i + 1) : '')
}
/** Public base URL of the site (for QR codes): the page's own origin and path. */
export const siteUrl = () => `${location.origin}${location.pathname}`

export const fmtTime = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`
export const ago = (t: number) => {
  const s = Math.max(0, Date.now() / 1000 - t)
  return s < 60 ? `${Math.floor(s)} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`
}
export const ALARM_LABEL: Record<string, string> = { fire: 'Fire', earthquake: 'Earthquake', collapse: 'Structural collapse', gas: 'Gas leak', drill: 'Evacuation drill', other: 'Emergency' }
/** Distance in metres between two map positions. */
export function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180, dp = (lat2 - lat1) * r, dl = (lng2 - lng1) * r
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(a))
}
/** Google Maps walking directions (no API key: a maps link; the phone's own location is the start). */
export const directionsUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`
export const mapEmbedUrl = (lat: number, lng: number, zoom = 17) => `https://maps.google.com/maps?q=${lat},${lng}&z=${zoom}&output=embed`
