// Reading plan files in the browser: PDF pages to PNG (pdf.js, loaded only when a PDF is dropped),
// images to data URLs, and shrinking a picture until the vision service accepts it.

export type PlanImage = { src: string; width: number; height: number; label: string }

const MAX_SIDE = 2400 // px: plenty for reading a plan, small enough to stay fast
export const VISION_MAX_BYTES = 3_500_000

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(r.result as string)
    r.onerror = () => fail(r.error ?? new Error('Could not read the file'))
    r.readAsDataURL(file)
  })
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image()
    img.onload = () => ok(img)
    img.onerror = () => fail(new Error('This file is not an image the browser can open'))
    img.src = src
  })
}

/** Bytes of a base64 data URL. */
export const dataUrlBytes = (src: string) => Math.floor((src.length - src.indexOf(',') - 1) * 3 / 4)

/** Every page of a PDF as a PNG, one per floor. */
export async function pdfPages(file: File, onPage?: (done: number, total: number) => void): Promise<PlanImage[]> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const out: PlanImage[] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(4, MAX_SIDE / Math.max(base.width, base.height))
      const vp = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport: vp }).promise
      out.push({ src: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, label: `${file.name}, page ${p}` })
      page.cleanup()
      onPage?.(p, doc.numPages)
    }
  } finally {
    void doc.destroy()
  }
  return out
}

export async function imageFile(file: File): Promise<PlanImage> {
  const src = await readAsDataUrl(file)
  const img = await loadImage(src)
  return { src, width: img.naturalWidth, height: img.naturalHeight, label: file.name }
}

/** The picture as PNG/JPEG data under the vision limit: big ones are redrawn smaller as JPEG. */
export async function forVision(src: string): Promise<string> {
  const okType = /^data:image\/(png|jpeg|webp);/.test(src)
  if (okType && dataUrlBytes(src) <= VISION_MAX_BYTES) return src
  const img = await loadImage(src)
  let side = Math.min(MAX_SIDE, Math.max(img.naturalWidth, img.naturalHeight))
  for (let tries = 0; tries < 6; tries++) {
    const k = side / Math.max(img.naturalWidth, img.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k)); canvas.height = Math.max(1, Math.round(img.naturalHeight * k))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const out = canvas.toDataURL('image/jpeg', 0.88)
    if (dataUrlBytes(out) <= VISION_MAX_BYTES) return out
    side = Math.round(side * 0.75)
  }
  throw new Error('This picture is too large to read, even after shrinking it')
}

export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
export const isJson = (f: File) => f.type === 'application/json' || /\.json$/i.test(f.name)
export const isImage = (f: File) => /^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name)
