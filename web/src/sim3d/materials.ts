/* eslint-disable @typescript-eslint/no-explicit-any */
// Every texture is drawn on a canvas at start-up: no image files, no downloads.
import * as THREE from 'three'

export function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(11)
type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void

/** Canvas texture. `meters` = how many metres one copy covers (UVs are in metres, see build.ts). */
function tex(w: number, h: number, draw: Draw, meters?: number | [number, number], srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  draw(c.getContext('2d')!, w, h)
  const t = new THREE.CanvasTexture(c)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  if (meters) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    const [mx, my] = Array.isArray(meters) ? meters : [meters, meters]
    t.repeat.set(1 / mx, 1 / my)
  }
  return t
}
function speckle(g: CanvasRenderingContext2D, w: number, h: number, n: number, a: number, size = 2) {
  for (let k = 0; k < n; k++) {
    g.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${a * rnd()})` : `rgba(255,255,255,${a * rnd()})`
    g.fillRect(rnd() * w, rnd() * h, size * (0.5 + rnd()), size * (0.5 + rnd()))
  }
}
function base(color: string, n: number, a: number, size = 2): Draw {
  return (g, w, h) => { g.fillStyle = color; g.fillRect(0, 0, w, h); speckle(g, w, h, n, a, size) }
}
function tiles(color: string, grout: string, n: number, vary: number, line = 2): Draw {
  return (g, w, h) => {
    const s = w / n
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      g.fillStyle = color; g.fillRect(i * s, j * s, s, s)
      g.fillStyle = `rgba(${rnd() < 0.5 ? 0 : 255},${rnd() < 0.5 ? 0 : 255},${rnd() < 0.5 ? 0 : 255},${vary * rnd()})`; g.fillRect(i * s, j * s, s, s)
    }
    speckle(g, w, h, w * 6, 0.05)
    g.fillStyle = grout
    for (let i = 0; i <= n; i++) { g.fillRect(i * s - line / 2, 0, line, h); g.fillRect(0, i * s - line / 2, w, line) }
  }
}
function planks(colors: string[], rows: number): Draw {
  return (g, w, h) => {
    const ph = h / rows
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * w * 0.5
      while (x < w) {
        const len = w * (0.3 + rnd() * 0.4)
        g.fillStyle = colors[Math.floor(rnd() * colors.length)]; g.fillRect(x, r * ph, len, ph)
        for (let k = 0; k < 8; k++) { g.fillStyle = `rgba(60,35,15,${0.05 + rnd() * 0.08})`; g.fillRect(x, r * ph + rnd() * ph, len, 1) }
        g.fillStyle = 'rgba(40,25,10,0.5)'; g.fillRect(x, r * ph, 2, ph)
        x += len
      }
      g.fillStyle = 'rgba(40,25,10,0.45)'; g.fillRect(0, r * ph, w, 1.5)
    }
  }
}

// ---- pictures for signs and screens (UVs 0..1 across the face) ----
function runner(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  g.strokeStyle = color; g.fillStyle = color; g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = s * 0.16
  g.beginPath(); g.arc(x + s * 0.18, y - s * 0.78, s * 0.12, 0, 7); g.fill()
  g.beginPath(); g.moveTo(x + s * 0.08, y - s * 0.6); g.lineTo(x - s * 0.06, y - s * 0.2) // torso
  g.moveTo(x - s * 0.06, y - s * 0.2); g.lineTo(x + s * 0.2, y - s * 0.02); g.lineTo(x + s * 0.12, y + s * 0.2) // front leg
  g.moveTo(x - s * 0.06, y - s * 0.2); g.lineTo(x - s * 0.22, y + 0.0); g.lineTo(x - s * 0.42, y + s * 0.02) // back leg
  g.moveTo(x + s * 0.06, y - s * 0.52); g.lineTo(x + s * 0.3, y - s * 0.38); g.lineTo(x + s * 0.4, y - s * 0.5) // front arm
  g.moveTo(x + s * 0.06, y - s * 0.52); g.lineTo(x - s * 0.16, y - s * 0.48); g.lineTo(x - s * 0.3, y - s * 0.32) // back arm
  g.stroke()
}
const exitPic: Draw = (g, w, h) => {
  g.fillStyle = '#0c8f4c'; g.fillRect(0, 0, w, h)
  g.fillStyle = '#ffffff'; g.fillRect(h * 0.12, h * 0.12, h * 0.76, h * 0.76)
  g.fillStyle = '#0c8f4c'; g.fillRect(h * 0.2, h * 0.2, h * 0.6, h * 0.6)
  runner(g, h * 0.5, h * 0.62, h * 0.5, '#ffffff')
  g.fillStyle = '#ffffff'; g.font = `800 ${h * 0.5}px "Big Shoulders Display", "Arial Narrow", sans-serif`; g.textBaseline = 'middle'
  g.fillText('EXIT', h * 1.05, h * 0.53)
  g.beginPath(); g.moveTo(w - h * 0.7, h * 0.3); g.lineTo(w - h * 0.35, h * 0.5); g.lineTo(w - h * 0.7, h * 0.7); g.closePath(); g.fill()
}
const assemblyPic: Draw = (g, w, h) => {
  g.fillStyle = '#0c8f4c'; g.fillRect(0, 0, w, h)
  g.strokeStyle = '#fff'; g.lineWidth = w * 0.03; g.strokeRect(w * 0.06, w * 0.06, w * 0.88, h - w * 0.12)
  const fig = (x: number, y: number, s: number) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y - s * 0.7, s * 0.18, 0, 7); g.fill(); g.fillRect(x - s * 0.2, y - s * 0.48, s * 0.4, s * 0.62) }
  fig(w * 0.32, h * 0.42, w * 0.22); fig(w * 0.68, h * 0.42, w * 0.22); fig(w * 0.5, h * 0.36, w * 0.22)
  g.strokeStyle = '#fff'; g.lineWidth = w * 0.02
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g.beginPath(); g.moveTo(w * (0.5 + dx * 0.36), h * (0.3 + dy * 0.18)); g.lineTo(w * (0.5 + dx * 0.26), h * (0.3 + dy * 0.12)); g.stroke() }
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = `800 ${w * 0.11}px "Big Shoulders Display", "Arial Narrow", sans-serif`
  g.fillText('ASSEMBLY', w / 2, h * 0.72); g.fillText('POINT', w / 2, h * 0.85)
}
const codePic: Draw = (g, w, h) => {
  g.fillStyle = '#0b1424'; g.fillRect(0, 0, w, h)
  const cols = ['#5eead4', '#93c5fd', '#fca5a5', '#fde68a', '#c4b5fd', '#e5e7eb']
  for (let y = 10; y < h - 6; y += 9) {
    let x = 10 + Math.floor(rnd() * 3) * 12
    while (x < w - 20 && rnd() > 0.15) { const l = 10 + rnd() * 40; g.fillStyle = cols[Math.floor(rnd() * cols.length)]; g.fillRect(x, y, l, 4); x += l + 6 }
  }
}
const slidePic: Draw = (g, w, h) => {
  g.fillStyle = '#f4f7fb'; g.fillRect(0, 0, w, h)
  g.fillStyle = '#14202b'; g.fillRect(0, 0, w, h * 0.16)
  g.fillStyle = '#ffffff'; g.font = `700 ${h * 0.09}px "Atkinson Hyperlegible", sans-serif`; g.fillText('Crowd flow through doorways', w * 0.04, h * 0.11)
  const bars = [0.35, 0.55, 0.8, 0.62, 0.9, 0.48]
  bars.forEach((b, k) => { g.fillStyle = k === 4 ? '#f05a22' : '#1e8c4e'; g.fillRect(w * (0.08 + k * 0.08), h * (0.9 - b * 0.6), w * 0.05, h * b * 0.6) })
  g.strokeStyle = '#94a3b8'; g.lineWidth = 2; g.beginPath(); g.moveTo(w * 0.06, h * 0.9); g.lineTo(w * 0.58, h * 0.9); g.stroke()
  g.fillStyle = '#4a5866'
  for (let k = 0; k < 5; k++) g.fillRect(w * 0.64, h * (0.3 + k * 0.11), w * (0.18 + rnd() * 0.12), h * 0.035)
}
const tvPic: Draw = (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#1d3b66'); gr.addColorStop(1, '#0b1626')
  g.fillStyle = gr; g.fillRect(0, 0, w, h)
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(w * 0.08, h * 0.12, w * 0.5, h * 0.08)
  for (let k = 0; k < 4; k++) { g.fillStyle = ['#38bdf8', '#f472b6', '#facc15', '#34d399'][k]; g.fillRect(w * (0.08 + k * 0.22), h * 0.4, w * 0.18, h * 0.42) }
}
const rackPic: Draw = (g, w, h) => {
  g.fillStyle = '#121418'; g.fillRect(0, 0, w, h)
  for (let y = 4; y < h; y += 14) {
    g.fillStyle = '#1d2026'; g.fillRect(6, y, w - 12, 11)
    for (let x = 12; x < w * 0.45; x += 9) { g.fillStyle = rnd() < 0.7 ? (rnd() < 0.8 ? '#22ff88' : '#ffb020') : '#18301f'; g.fillRect(x, y + 4, 4, 3) }
    g.fillStyle = rnd() < 0.5 ? '#3aa0ff' : '#0d2238'; g.fillRect(w - 22, y + 4, 8, 3)
  }
}
const booksPic: Draw = (g, w, h) => {
  g.fillStyle = '#5a3d27'; g.fillRect(0, 0, w, h)
  const cols = ['#7f1d1d', '#1e3a8a', '#14532d', '#78350f', '#334155', '#9a3412', '#e5e7eb', '#0f766e', '#6b21a8', '#a16207']
  const rows = 5, rh = h / rows
  for (let r = 0; r < rows; r++) {
    let x = 4
    while (x < w - 4) {
      const bw = 5 + rnd() * 9, bh = rh * (0.62 + rnd() * 0.3)
      if (rnd() < 0.06) { x += bw * 2; continue }
      g.fillStyle = cols[Math.floor(rnd() * cols.length)]; g.fillRect(x, r * rh + rh - bh - 6, bw - 1, bh)
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x + 1, r * rh + rh - bh, bw - 3, 2)
      x += bw
    }
    g.fillStyle = '#3d2817'; g.fillRect(0, r * rh + rh - 6, w, 6)
  }
}
const whiteboardPic: Draw = (g, w, h) => {
  g.fillStyle = '#fbfcfd'; g.fillRect(0, 0, w, h)
  g.strokeStyle = '#94a3b8'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6)
  g.lineWidth = 3
  for (let k = 0; k < 6; k++) {
    g.strokeStyle = ['#1d4ed8', '#b91c1c', '#15803d'][k % 3]; g.beginPath()
    let x = w * 0.08
    const y = h * (0.15 + k * 0.12); g.moveTo(x, y)
    while (x < w * (0.4 + rnd() * 0.5)) { x += 8; g.lineTo(x, y + Math.sin(x * 0.3) * 3) }
    g.stroke()
  }
}
const corkPic: Draw = (g, w, h) => {
  g.fillStyle = '#b88a5a'; g.fillRect(0, 0, w, h); speckle(g, w, h, 900, 0.25)
  g.strokeStyle = '#6b4c2e'; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8)
  for (let k = 0; k < 7; k++) { g.fillStyle = ['#fff', '#fef08a', '#bfdbfe', '#fecaca', '#fff'][k % 5]; g.save(); g.translate(20 + rnd() * (w - 70), 16 + rnd() * (h - 60)); g.rotate((rnd() - 0.5) * 0.2); g.fillRect(0, 0, 40, 46); g.restore() }
}
const evacPic: Draw = (g, w, h) => {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h)
  g.fillStyle = '#0c8f4c'; g.fillRect(0, 0, w, h * 0.16)
  g.fillStyle = '#fff'; g.font = `800 ${h * 0.1}px "Big Shoulders Display", sans-serif`; g.fillText('EVACUATION PLAN', w * 0.05, h * 0.12)
  g.strokeStyle = '#14202b'; g.lineWidth = 3; g.strokeRect(w * 0.08, h * 0.26, w * 0.84, h * 0.62)
  g.beginPath(); g.moveTo(w * 0.08, h * 0.52); g.lineTo(w * 0.92, h * 0.52); g.moveTo(w * 0.08, h * 0.62); g.lineTo(w * 0.92, h * 0.62); g.stroke()
  g.strokeStyle = '#16a34a'; g.lineWidth = 4; g.beginPath(); g.moveTo(w * 0.5, h * 0.57); g.lineTo(w * 0.1, h * 0.57); g.moveTo(w * 0.5, h * 0.57); g.lineTo(w * 0.9, h * 0.57); g.stroke()
  g.fillStyle = '#dc2626'; g.beginPath(); g.arc(w * 0.5, h * 0.57, 6, 0, 7); g.fill()
}
const menuPic: Draw = (g, w, h) => {
  g.fillStyle = '#111317'; g.fillRect(0, 0, w, h)
  g.fillStyle = '#fbbf24'; g.font = `800 ${h * 0.16}px "Big Shoulders Display", sans-serif`; g.fillText('CAFE', w * 0.05, h * 0.2)
  for (let k = 0; k < 5; k++) { g.fillStyle = '#e5e7eb'; g.fillRect(w * 0.05, h * (0.32 + k * 0.13), w * (0.3 + rnd() * 0.2), h * 0.05); g.fillStyle = '#34d399'; g.fillRect(w * 0.82, h * (0.32 + k * 0.13), w * 0.1, h * 0.05) }
}
const vendPic: Draw = (g, w, h) => {
  g.fillStyle = '#0f172a'; g.fillRect(0, 0, w, h)
  for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) { g.fillStyle = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#e5e7eb'][(r + c) % 5]; g.fillRect(w * (0.08 + c * 0.16), h * (0.08 + r * 0.17), w * 0.1, h * 0.11) }
  g.fillStyle = '#38bdf8'; g.fillRect(w * 0.76, h * 0.1, w * 0.16, h * 0.3)
}
const crossPic: Draw = (g, w, h) => {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h)
  g.fillStyle = '#16a34a'; g.fillRect(w * 0.38, h * 0.15, w * 0.24, h * 0.7); g.fillRect(w * 0.15, h * 0.38, w * 0.7, h * 0.24)
}

export function makeMats() {
  const std = (o: any) => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...o })
  const keep = (m: any) => { m.userData.keepUV = true; return m }
  const glow = (r: number, g: number, b: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), toneMapped: false })
  const emissivePic = (draw: Draw, w: number, h: number, k: number) => keep(std({ color: '#050608', roughness: 0.3, emissive: '#ffffff', emissiveMap: tex(w, h, draw), emissiveIntensity: k }))

  const M = {
    plaster: std({ map: tex(256, 256, base('#efebe4', 1800, 0.05), 2), roughness: 0.95 }),
    plasterWarm: std({ map: tex(256, 256, base('#e9e2d6', 1800, 0.05), 2), roughness: 0.95 }),
    cladding: std({ map: tex(512, 512, (g, w, h) => {
      base('#d7d2c8', 4000, 0.06)(g, w, h)
      g.fillStyle = '#aaa59b'; g.fillRect(0, 0, w, 3); g.fillRect(0, h / 2, w, 3); g.fillRect(0, 0, 3, h); g.fillRect(w / 2, 0, 3, h)
    }, 3), roughness: 0.8 }),
    claddingDark: std({ color: '#454b53', roughness: 0.6, metalness: 0.2 }),
    glass: std({ color: '#7fa7bd', transparent: true, opacity: 0.32, roughness: 0.04, metalness: 0.3, depthWrite: false, emissive: '#ffcf8a', emissiveIntensity: 0.05 }),
    frame: std({ color: '#2e343c', roughness: 0.45, metalness: 0.55 }),
    concrete: std({ map: tex(256, 256, base('#b7b2a8', 2600, 0.12, 3), 3), roughness: 0.92 }),
    tile: std({ map: tex(512, 512, tiles('#d4d7d9', '#aeb4b9', 2, 0.04), 1.2), roughness: 0.35 }),
    marble: std({ map: tex(512, 512, (g, w, h) => {
      tiles('#e9e5dd', '#cfc9be', 2, 0.03, 2)(g, w, h)
      g.strokeStyle = 'rgba(120,115,105,0.25)'; g.lineWidth = 1.2
      for (let k = 0; k < 14; k++) { g.beginPath(); let x = rnd() * w, y = rnd() * h; g.moveTo(x, y); for (let s = 0; s < 12; s++) { x += (rnd() - 0.3) * 40; y += (rnd() - 0.5) * 30; g.lineTo(x, y) } g.stroke() }
    }, 2.4), roughness: 0.2 }),
    carpetBlue: std({ map: tex(256, 256, base('#34425c', 9000, 0.12, 1.5), 1), roughness: 1 }),
    carpetGrey: std({ map: tex(256, 256, base('#5a6270', 9000, 0.12, 1.5), 1), roughness: 1 }),
    carpetRed: std({ map: tex(256, 256, base('#6d3438', 9000, 0.12, 1.5), 1), roughness: 1 }),
    vinyl: std({ map: tex(256, 256, base('#cbbd9e', 2200, 0.08), 1.5), roughness: 0.5 }),
    woodFloor: std({ map: tex(512, 512, planks(['#a07850', '#93693f', '#ab845a', '#8a6038'], 10), 2), roughness: 0.5 }),
    epoxy: std({ map: tex(256, 256, base('#b4c2c9', 2200, 0.08), 2), roughness: 0.3 }),
    checker: std({ map: tex(256, 256, (g, w, h) => { for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#c8c0b0' : '#dcd6ca'; g.fillRect(i * w / 2, j * h / 2, w / 2, h / 2) } speckle(g, w, h, 900, 0.05) }, 0.8), roughness: 0.4 }),
    nosing: std({ color: '#e8b923', roughness: 0.55 }),
    steel: std({ color: '#a9b2ba', metalness: 0.85, roughness: 0.28 }),
    darkMetal: std({ color: '#2b2f35', metalness: 0.6, roughness: 0.4 }),
    greyMetal: std({ color: '#7a828b', metalness: 0.5, roughness: 0.45 }),
    whiteLam: std({ color: '#f1f0ed', roughness: 0.5 }),
    wood: std({ map: tex(256, 256, planks(['#b98a5c', '#a87b50', '#c29466'], 6), 1), roughness: 0.55 }),
    woodDark: std({ map: tex(256, 256, planks(['#6e4b31', '#5f3f28', '#7a5438'], 6), 1), roughness: 0.6 }),
    fabricBlue: std({ color: '#2f4672', roughness: 0.95 }),
    fabricGrey: std({ color: '#4c535d', roughness: 0.95 }),
    fabricRed: std({ color: '#8f3434', roughness: 0.95 }),
    fabricTeal: std({ color: '#2f6f6b', roughness: 0.95 }),
    leather: std({ color: '#3b2a22', roughness: 0.6 }),
    plant: std({ color: '#4c8a3a', roughness: 0.8, flatShading: true }),
    plantDark: std({ color: '#2f6a2c', roughness: 0.8, flatShading: true }),
    pot: std({ color: '#d8d2c8', roughness: 0.7 }),
    red: std({ color: '#c62828', roughness: 0.4, metalness: 0.2 }),
    black: std({ color: '#16181c', roughness: 0.5 }),
    cardboard: std({ color: '#b48a5a', roughness: 0.9 }),
    bedding: std({ color: '#e3ecef', roughness: 0.9 }),
    curtain: std({ color: '#9cc9c4', roughness: 0.9, side: THREE.DoubleSide }),
    counter: std({ color: '#d6c7b2', roughness: 0.45 }),
    rubber: std({ color: '#1b1d21', roughness: 0.9 }),
    grass: std({ map: tex(256, 256, (g, w, h) => { base('#2d5228', 0, 0)(g, w, h); for (let k = 0; k < 5000; k++) { g.fillStyle = `rgba(${60 + rnd() * 50},${100 + rnd() * 60},${40 + rnd() * 30},${0.3 + rnd() * 0.4})`; g.fillRect(rnd() * w, rnd() * h, 1, 2 + rnd() * 3) } }, 4), roughness: 1 }),
    paving: std({ map: tex(256, 256, tiles('#8f8b84', '#6f6b65', 4, 0.08, 3), 2), roughness: 0.85 }),
    asphalt: std({ map: tex(256, 256, base('#2a2c30', 9000, 0.15, 1.5), 4), roughness: 0.95 }),
    paint: std({ color: '#e8e6df', roughness: 0.7 }),
    paintYellow: std({ color: '#e0b21e', roughness: 0.7 }),
    hedge: std({ color: '#2c5a2a', roughness: 0.9, flatShading: true }),
    bark: std({ color: '#4a3526', roughness: 0.9 }),

    books: keep(std({ map: tex(256, 512, booksPic) })),
    whiteboard: keep(std({ map: tex(512, 256, whiteboardPic), roughness: 0.25 })),
    cork: keep(std({ map: tex(256, 192, corkPic) })),
    evacMap: keep(std({ map: tex(256, 192, evacPic), roughness: 0.4 })),
    cross: keep(std({ map: tex(64, 64, crossPic), emissive: '#ffffff', emissiveMap: tex(64, 64, crossPic), emissiveIntensity: 0.6 })),
    screenCode: emissivePic(codePic, 256, 160, 1.6),
    screenSlide: emissivePic(slidePic, 512, 288, 0.85),
    screenTV: emissivePic(tvPic, 256, 144, 1.4),
    rackFront: emissivePic(rackPic, 128, 256, 2.0),
    menu: emissivePic(menuPic, 256, 128, 1.3),
    vend: emissivePic(vendPic, 128, 256, 1.5),
    exitSign: keep(new THREE.MeshBasicMaterial({ map: tex(384, 128, exitPic), toneMapped: false, color: new THREE.Color(1.45, 1.45, 1.45) })),
    assemblySign: keep(std({ map: tex(256, 320, assemblyPic), emissive: '#ffffff', emissiveMap: tex(256, 320, assemblyPic), emissiveIntensity: 0.55 })),

    // dynamic glows (the engine changes these during the alarm)
    strobe: new THREE.MeshStandardMaterial({ color: '#3a0a0a', emissive: '#ff2020', emissiveIntensity: 0, roughness: 0.4 }),
    lightStrip: glow(1.3, 1.12, 0.86),
    egress: glow(0.12, 0.75, 0.38),
    ledBlue: glow(0.4, 0.9, 2.4),
    lamp: glow(2.4, 2.0, 1.4),
    windowGlow: glow(1.2, 0.95, 0.6),
    cars: ['#b91c1c', '#1d4ed8', '#e5e7eb', '#111827', '#a3a3a3', '#0f766e'].map(c => std({ color: c, metalness: 0.6, roughness: 0.32 })),
  }
  M.strobe.userData.noShadow = true
  return M
}
export type Mats = ReturnType<typeof makeMats>

/** Floor lettering for a room name. */
export function labelTex(text: string, color = 'rgba(20,32,43,0.55)') {
  return tex(1024, 160, (g, w, h) => {
    g.fillStyle = color; g.font = `700 ${h * 0.5}px "Atkinson Hyperlegible", "Segoe UI", sans-serif`
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2, w - 20)
  })
}
/** Soft round sprite used by fire, smoke and dust. */
export function softDot() {
  return tex(64, 64, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2)
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = gr; g.fillRect(0, 0, w, w)
  }, undefined, false)
}
export function radialTex(inner: string, outer: string) {
  return tex(128, 128, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2)
    gr.addColorStop(0, inner); gr.addColorStop(1, outer)
    g.fillStyle = gr; g.fillRect(0, 0, w, w)
  })
}
