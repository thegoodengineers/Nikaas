// All sound is synthesised with Web Audio: a whooping fire siren, earthquake rumble, crash, fire roar, UI blips.
export class Sound {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private noise!: AudioBuffer
  private siren: { stop: () => void } | null = null
  private fireGain: GainNode | null = null
  muted = false

  init() {
    if (this.ctx) { void this.ctx.resume(); return }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    this.ctx = ctx
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.9
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4
    this.master.connect(comp); comp.connect(ctx.destination)
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    let b = 0
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = (b + 0.02 * w) / 1.02; d[i] = w * 0.5 + b * 3 }
  }

  setMuted(m: boolean) {
    this.muted = m
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05)
  }

  private src(loop = false) {
    const s = this.ctx!.createBufferSource(); s.buffer = this.noise; s.loop = loop; return s
  }

  sirenOn() {
    const ctx = this.ctx
    if (!ctx || this.siren) return
    const out = ctx.createGain(); out.gain.value = 0
    out.gain.setTargetAtTime(0.085, ctx.currentTime, 0.08)
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600
    const a = ctx.createOscillator(); a.type = 'sawtooth'; a.frequency.value = 760
    const b = ctx.createOscillator(); b.type = 'square'; b.frequency.value = 763
    const bg = ctx.createGain(); bg.gain.value = 0.35
    // a rising sweep every 0.85 s: the classic "whoop"
    const lfo = ctx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 1 / 0.85
    const depth = ctx.createGain(); depth.gain.value = 380
    lfo.connect(depth); depth.connect(a.frequency); depth.connect(b.frequency)
    a.connect(lp); b.connect(bg); bg.connect(lp); lp.connect(out); out.connect(this.master)
    a.start(); b.start(); lfo.start()
    this.siren = {
      stop: () => {
        out.gain.setTargetAtTime(0, ctx.currentTime, 0.15)
        setTimeout(() => { a.stop(); b.stop(); lfo.stop(); out.disconnect() }, 900)
      },
    }
  }
  sirenOff() { this.siren?.stop(); this.siren = null }

  rumble(dur: number, strength = 1) {
    const ctx = this.ctx
    if (!ctx) return
    const t = ctx.currentTime
    const s = this.src(true), lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 110
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.9 * strength, t + 0.6)
    g.gain.setValueAtTime(0.9 * strength, t + Math.max(0.7, dur - 1.2)); g.gain.linearRampToValueAtTime(0, t + dur)
    s.connect(lp); lp.connect(g); g.connect(this.master); s.start(t); s.stop(t + dur + 0.1)
    const o = ctx.createOscillator(); o.frequency.value = 34
    const og = ctx.createGain(); og.gain.setValueAtTime(0, t); og.gain.linearRampToValueAtTime(0.35 * strength, t + 0.5); og.gain.linearRampToValueAtTime(0, t + dur)
    o.connect(og); og.connect(this.master); o.start(t); o.stop(t + dur + 0.1)
  }

  crash(strength = 1) {
    const ctx = this.ctx
    if (!ctx) return
    const t = ctx.currentTime
    const s = this.src(), bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6
    const g = ctx.createGain(); g.gain.setValueAtTime(0.9 * strength, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.6)
    s.connect(bp); bp.connect(g); g.connect(this.master); s.start(t); s.stop(t + 1.7)
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.7)
    const og = ctx.createGain(); og.gain.setValueAtTime(0.8 * strength, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.9)
    o.connect(og); og.connect(this.master); o.start(t); o.stop(t + 1)
  }

  /** Background roar that grows with the number and size of fires (0..1). */
  fire(level: number) {
    const ctx = this.ctx
    if (!ctx) return
    if (!this.fireGain) {
      const s = this.src(true), bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 700
      this.fireGain = ctx.createGain(); this.fireGain.gain.value = 0
      s.connect(bp); bp.connect(this.fireGain); this.fireGain.connect(this.master); s.start()
    }
    this.fireGain.gain.setTargetAtTime(Math.min(1, level) * 0.22, ctx.currentTime, 0.4)
  }

  blip(freq = 880, dur = 0.07, vol = 0.12) {
    const ctx = this.ctx
    if (!ctx) return
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain()
    o.type = 'sine'; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur)
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02)
  }

  dispose() {
    this.sirenOff()
    const ctx = this.ctx
    this.ctx = null
    if (ctx) setTimeout(() => void ctx.close(), 950)
  }
}
