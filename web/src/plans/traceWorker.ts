// Runs wall tracing off the main thread (see trace.ts).
import { traceCells, type TraceOpts } from './traceCore.ts'

type Job = { px: Uint8ClampedArray; pw: number; ph: number; cols: number; rows: number; res: number; opts: TraceOpts }

self.onmessage = (ev: MessageEvent<Job>) => {
  const j = ev.data
  try {
    const { cells, stats } = traceCells(j.px, j.pw, j.ph, j.cols, j.rows, j.res, j.opts)
    ;(self as unknown as Worker).postMessage({ cells, stats }, [cells.buffer])
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ error: e instanceof Error ? e.message : String(e) })
  }
}
