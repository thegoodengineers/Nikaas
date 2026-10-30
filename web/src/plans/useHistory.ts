// Undo/redo for the editor: every change makes a new document; up to LIMIT earlier ones are kept.
import { useCallback, useState } from 'react'

const LIMIT = 100

type State<T> = { past: T[]; present: T; future: T[]; saved: T }

export function useHistory<T>(initial: T) {
  const [s, setS] = useState<State<T>>({ past: [], present: initial, future: [], saved: initial })
  /** A change that can be undone on its own. */
  const commit = useCallback((fn: (d: T) => T) => setS(st => {
    const next = fn(st.present)
    if (next === st.present) return st
    return { ...st, past: [...st.past, st.present].slice(-LIMIT), present: next, future: [] }
  }), [])
  /** Remember the current state as one undo step (call before a drag), then change it with `live`. */
  const checkpoint = useCallback(() => setS(st => ({ ...st, past: [...st.past, st.present].slice(-LIMIT), future: [] })), [])
  const live = useCallback((fn: (d: T) => T) => setS(st => ({ ...st, present: fn(st.present) })), [])
  /** Drop a checkpoint that turned out to change nothing (a click without a drag). */
  const dropCheckpoint = useCallback(() => setS(st => (st.past.length && st.past[st.past.length - 1] === st.present ? { ...st, past: st.past.slice(0, -1) } : st)), [])
  const undo = useCallback(() => setS(st => st.past.length
    ? { ...st, past: st.past.slice(0, -1), present: st.past[st.past.length - 1], future: [st.present, ...st.future] } : st), [])
  const redo = useCallback(() => setS(st => st.future.length
    ? { ...st, past: [...st.past, st.present], present: st.future[0], future: st.future.slice(1) } : st), [])
  const markSaved = useCallback(() => setS(st => ({ ...st, saved: st.present })), [])
  const reset = useCallback((d: T) => setS({ past: [], present: d, future: [], saved: d }), [])
  return {
    doc: s.present, commit, live, checkpoint, dropCheckpoint, undo, redo, markSaved, reset,
    canUndo: s.past.length > 0, canRedo: s.future.length > 0, dirty: s.present !== s.saved, steps: s.past.length,
  }
}
