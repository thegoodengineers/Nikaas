// Metres or feet for every length the editor shows or takes. The building always stores metres.
import { useSyncExternalStore } from 'react'

export type Units = 'm' | 'ft'
export const FT = 0.3048
const KEY = 'nikaas-units'
const subs = new Set<() => void>()

function read(): Units {
  try { return localStorage.getItem(KEY) === 'ft' ? 'ft' : 'm' } catch { return 'm' }
}
let current: Units = read()

export function setUnits(u: Units) {
  current = u
  try { localStorage.setItem(KEY, u) } catch { /* private mode: this session only */ }
  for (const f of subs) f()
}
export function useUnits(): Units {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => current)
}

/** Metres to the display unit. */
export const toU = (m: number, u: Units) => (u === 'ft' ? m / FT : m)
/** Display unit to metres. */
export const fromU = (v: number, u: Units) => (u === 'ft' ? v * FT : v)
const r = (v: number, d: number) => { const k = 10 ** d; return Math.round(v * k) / k }
/** "1.5 m" or "4.9 ft". */
export const fmtLen = (m: number, u: Units, digits = u === 'ft' ? 1 : 2) => `${r(toU(m, u), digits)} ${u}`
/** Just the number in the display unit, rounded for an input box. */
export const numU = (m: number, u: Units, digits = 2) => r(toU(m, u), digits)
