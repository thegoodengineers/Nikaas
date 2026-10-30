// Shared camera helpers: the in-browser person detector (COCO-SSD on TensorFlow.js, vendored in public/vendor/)
// and a quick fire / smoke check on each frame. Nothing here sends video anywhere.
const BASE = import.meta.env.BASE_URL
export type Box = { bbox: [number, number, number, number]; class: string; score: number }
export type Detector = { detect: (v: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement, maxBoxes?: number, minScore?: number) => Promise<Box[]> }
declare global { interface Window { cocoSsd?: { load: (o: { base: string; modelUrl: string }) => Promise<Detector> } } }

function loadScript(src: string) {
  return new Promise<void>((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok()
    const s = document.createElement('script')
    s.src = src; s.onload = () => ok(); s.onerror = () => fail(new Error(`Could not load ${src}`))
    document.head.appendChild(s)
  })
}
let detector: Promise<Detector> | undefined
export function getDetector() {
  detector ??= (async () => {
    await loadScript(`${BASE}vendor/tfjs/tf.min.js`)
    await loadScript(`${BASE}vendor/coco-ssd/coco-ssd.min.js`)
    return window.cocoSsd!.load({ base: 'lite_mobilenet_v2', modelUrl: `${BASE}vendor/coco-ssd/model.json` })
  })()
  detector.catch(() => { detector = undefined })
  return detector
}
export const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

/** Quick fire / smoke check on a small copy of the frame. Fire: the classic RGB flame-colour rule (Chen, Wu and
 * Chiou 2004: R above a threshold, R >= G > B, enough saturation) plus flicker over the last second. Smoke: a
 * growing share of grey, low-contrast pixels compared with the first seconds of the camera. Scores are 0..1 and
 * only decide when to ask the server for a second opinion (Amazon Rekognition); they never raise an alarm alone
 * unless they are very strong. */
export class FireCheck {
  private c = document.createElement('canvas')
  private g = this.c.getContext('2d', { willReadFrequently: true })!
  private fireHist: number[] = []
  private grayBase: number[] = []
  private contrastBase: number[] = []
  constructor() { this.c.width = 160; this.c.height = 120 }

  measure(src: CanvasImageSource): { fire: number; smoke: number; fireFrac: number } {
    this.g.drawImage(src, 0, 0, 160, 120)
    const d = this.g.getImageData(0, 0, 160, 120).data
    let fire = 0, gray = 0, sum = 0, sum2 = 0
    const n = d.length / 4
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2]
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      const s = max ? (max - min) / max : 0
      if (r > 135 && r >= g && g > b && s >= ((255 - r) * 0.2) / 135 && s > 0.25) fire++
      const y = 0.299 * r + 0.587 * g + 0.114 * b
      if (max - min < 22 && y > 70 && y < 225) gray++
      sum += y; sum2 += y * y
    }
    const fireFrac = fire / n, grayFrac = gray / n
    const contrast = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2))
    this.fireHist.push(fireFrac)
    if (this.fireHist.length > 8) this.fireHist.shift()
    if (this.grayBase.length < 15) { this.grayBase.push(grayFrac); this.contrastBase.push(contrast) }
    const mean = this.fireHist.reduce((a, b) => a + b, 0) / this.fireHist.length
    const flicker = this.fireHist.length > 3 ? Math.sqrt(this.fireHist.reduce((a, b) => a + (b - mean) ** 2, 0) / this.fireHist.length) / (mean || 1) : 0
    // a still photo of a fire does not flicker, but must still be caught: flicker raises the score, it is not required
    const fireScore = Math.min(1, fireFrac * 12) * (0.75 + 0.25 * Math.min(1, flicker * 4))
    const gb = this.grayBase.length ? this.grayBase.reduce((a, b) => a + b, 0) / this.grayBase.length : grayFrac
    const cb = this.contrastBase.length ? this.contrastBase.reduce((a, b) => a + b, 0) / this.contrastBase.length : contrast
    const smokeScore = this.grayBase.length < 15 ? 0 : Math.min(1, Math.max(0, grayFrac - gb) * 3) * Math.min(1, Math.max(0.3, 1 - contrast / (cb || 1) + 0.5))
    return { fire: +fireScore.toFixed(2), smoke: +smokeScore.toFixed(2), fireFrac }
  }

  /** One small JPEG of the frame for the server's second opinion. */
  still(src: CanvasImageSource, w: number, h: number) {
    const c = document.createElement('canvas'), k = Math.min(1, 640 / Math.max(w, h))
    c.width = Math.round(w * k); c.height = Math.round(h * k)
    c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.75)
  }
}
