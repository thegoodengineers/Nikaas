// Alerts on the phone: Web Push through the service worker (works with the page closed), and an in-page
// siren + vibration when the page is open. Push needs HTTPS (or localhost) and, on iPhone, the app added to
// the Home Screen.
import { api } from '../platform/api.ts'

export type PushState = 'on' | 'off' | 'denied' | 'unsupported' | 'needs-install'

export function pushSupport(): PushState | null {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return 'unsupported'
  if (!('PushManager' in window) || !('Notification' in window)) {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    const standalone = (navigator as Navigator & { standalone?: boolean }).standalone || matchMedia('(display-mode: standalone)').matches
    return ios && !standalone ? 'needs-install' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'denied'
  return null
}

export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null
  try { return await navigator.serviceWorker.register('sw.js', { scope: './' }) } catch { return null }
}

function keyBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

/** Ask for notification permission and register this phone for pushes on `site`. */
export async function enablePush(site: string, token: string): Promise<PushState> {
  const blocked = pushSupport()
  if (blocked) return blocked
  const reg = await registerWorker()
  if (!reg) return 'unsupported'
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off'
  await navigator.serviceWorker.ready
  const { public_key } = await api.get<{ public_key: string }>('/push/key')
  let sub = await reg.pushManager.getSubscription()
  const want = keyBytes(public_key)
  const current = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey as ArrayBuffer) : null
  if (sub && current && (current.length !== want.length || current.some((v, i) => v !== want[i]))) { await sub.unsubscribe(); sub = null }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want })
  await api.post(`/sites/${site}/push`, { token, subscription: sub.toJSON() })
  return 'on'
}

let ctx: AudioContext | null = null
let sirenStop: (() => void) | null = null
/** Call from a tap (browsers only allow sound after the user has touched the page). */
export function unlockAudio() {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return
  ctx ??= new AC()
  void ctx.resume()
}
export function siren(on: boolean) {
  if (!on) { sirenStop?.(); sirenStop = null; return }
  if (sirenStop || !ctx) return
  const c = ctx, g = c.createGain(), o = c.createOscillator()
  g.gain.value = 0.0001; o.type = 'square'; o.connect(g); g.connect(c.destination); o.start()
  // temporal-three pattern (ISO 8201), the standard evacuation signal: three 0.5 s tones, then a pause
  let alive = true
  const cycle = () => {
    if (!alive) return
    const t = c.currentTime
    for (let k = 0; k < 3; k++) {
      o.frequency.setValueAtTime(880, t + k)
      g.gain.setValueAtTime(0.0001, t + k); g.gain.exponentialRampToValueAtTime(0.16, t + k + 0.03)
      g.gain.setValueAtTime(0.16, t + k + 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t + k + 0.53)
    }
    navigator.vibrate?.([500, 500, 500, 500, 500, 1500])
    timer = window.setTimeout(cycle, 4000)
  }
  let timer = 0
  cycle()
  sirenStop = () => { alive = false; clearTimeout(timer); g.gain.cancelScheduledValues(c.currentTime); g.gain.value = 0; o.stop(c.currentTime + 0.05); navigator.vibrate?.(0) }
}
