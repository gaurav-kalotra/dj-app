import { getAudioContext } from "./AudioEngine"
import { Deck } from "./Deck"
import type { DeckId, TrackInfo, TransitionPlan } from "./types"

const CURVE_N = 128  // automation curve resolution

export interface TransitionTiming {
  delayMs: number    // ms until the blend starts (for fader animation)
  durationMs: number // ms of the actual blend (for fader animation)
}

export class Mixer {
  private ctx: AudioContext
  readonly master: GainNode
  readonly deckA: Deck
  readonly deckB: Deck

  constructor() {
    this.ctx    = getAudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = 1.0
    this.master.connect(this.ctx.destination)

    this.deckA = new Deck("A", this.ctx, this.master)
    this.deckB = new Deck("B", this.ctx, this.master)

    this.deckA.gain.gain.value = 1.0
    this.deckB.gain.gain.value = 0.0
  }

  deck(id: DeckId): Deck {
    return id === "A" ? this.deckA : this.deckB
  }

  /**
   * Real-time crossfader: 0 = full A, 1 = full B.
   * Equal-power gain + bass kill + HPF sweep.
   */
  setCrossfade(value: number): void {
    const v   = Math.max(0, Math.min(1, value))
    const now = this.ctx.currentTime
    const tau = 0.008

    const snap = (p: AudioParam) => {
      const val = p.value; p.cancelScheduledValues(now); p.setValueAtTime(val, now)
    }
    snap(this.deckA.gain.gain);     snap(this.deckB.gain.gain)
    snap(this.deckA.lowEQ.gain);    snap(this.deckB.lowEQ.gain)
    snap(this.deckA.hpf.frequency); snap(this.deckB.hpf.frequency)

    // Equal-power gain
    this.deckA.gain.gain.setTargetAtTime(Math.cos(v * Math.PI / 2), now, tau)
    this.deckB.gain.gain.setTargetAtTime(Math.sin(v * Math.PI / 2), now, tau)

    // Bass kill — starts 30% from each edge
    const bassA = v < 0.3 ? 0 : -40 * Math.min((v - 0.3) / 0.7, 1)
    const bassB = v > 0.7 ? 0 : -40 * Math.min((0.7 - v) / 0.7, 1)
    this.deckA.lowEQ.gain.setTargetAtTime(bassA, now, tau)
    this.deckB.lowEQ.gain.setTargetAtTime(bassB, now, tau)

    // HPF sweep — log scale 20 Hz ↔ 800 Hz
    this.deckA.hpf.frequency.setTargetAtTime(20 * Math.pow(40, v), now, tau)
    this.deckB.hpf.frequency.setTargetAtTime(20 * Math.pow(40, 1 - v), now, tau)

    // Auto tempo sync as fader crosses 5%
    if (v > 0.05 && this.deckA.playing && this.deckB.track && !this.deckB.playing) {
      this.deckB.setTempo(this.deckA.track!.bpm / this.deckB.track.bpm)
    }
    if (v < 0.95 && this.deckB.playing && this.deckA.track && !this.deckA.playing) {
      this.deckA.setTempo(this.deckB.track!.bpm / this.deckA.track.bpm)
    }
  }

  getCrossfade(): number {
    const gainB = this.deckB.gain.gain.value
    return Math.asin(Math.max(0, Math.min(1, gainB))) / (Math.PI / 2)
  }

  syncTempos(): void {
    if (this.deckA.playing && this.deckB.track) {
      this.deckB.setTempo(this.deckA.track!.bpm / this.deckB.track.bpm)
    } else if (this.deckB.playing && this.deckA.track) {
      this.deckA.setTempo(this.deckB.track!.bpm / this.deckA.track.bpm)
    }
  }

  /**
   * Organic transition with five layers of intelligence:
   *
   * 1. S-curve equal-power crossfade — no mid-dip, natural energy arc
   * 2. True bass swap — bass gap in the middle so low ends never clash
   * 3. Energy-aware timing — waits for a low-energy moment on the outgoing track
   * 4. Structure awareness — prefers outro boundaries; cues incoming at its intro
   * 5. Variation — blend length 24–40 beats based on track energy; ±1 beat jitter
   */
  async transition(plan: TransitionPlan): Promise<TransitionTiming> {
    const out = this.deck(plan.outgoing)
    const inc = this.deck(plan.incoming)
    if (!out.track || !inc.track) return { delayMs: 0, durationMs: 0 }

    // ── 1. TEMPO SYNC ────────────────────────────────────────────────────────
    inc.setTempo(out.track.bpm / inc.track.bpm)

    // ── 2. BLEND DURATION — energy-based variation (24–40 beats) ────────────
    const avgE       = _avgEnergy(out.track)
    const blendBeats = Math.round(24 + (1 - Math.min(1, avgE * 1.5)) * 16)
    const beatDur    = 60 / out.track.bpm
    const blendSec   = beatDur * blendBeats

    // ── 3. ENERGY-AWARE + STRUCTURE-AWARE START TIME ─────────────────────────
    const startDelay = this._findTransitionPoint(out, beatDur, blendBeats)

    // ── 4. RANDOM JITTER ±1 beat ─────────────────────────────────────────────
    const jitter = (Math.random() - 0.5) * 2 * beatDur

    // ── 5. STRUCTURE: cue incoming at its intro ───────────────────────────────
    const incCue = _findIntroCue(inc.track)

    // Timeline anchors
    const now = this.ctx.currentTime
    const t0  = now + Math.max(0, startDelay + jitter)  // blend start
    const t1  = t0 + blendSec * 0.30   // outgoing bass fully dead
    const t2  = t0 + blendSec * 0.65   // incoming bass starts rising
    const t4  = t0 + blendSec          // blend complete

    // Pre-roll incoming: silent, filtered, bass cut — ready before t0
    inc.play(incCue)
    inc.gain.gain.setValueAtTime(0, now)
    inc.lowEQ.gain.setValueAtTime(-40, now)
    inc.hpf.frequency.setValueAtTime(800, now)

    // ── S-CURVE EQUAL-POWER CROSSFADE ────────────────────────────────────────
    // ease-in-out shaping over equal-power curve = slow fade in/out with no dip
    const outGain = _sCurve(CURVE_N, t => Math.cos(t * Math.PI / 2))
    const incGain = _sCurve(CURVE_N, t => Math.sin(t * Math.PI / 2))

    out.gain.gain.setValueAtTime(1.0, t0)
    out.gain.gain.setValueCurveAtTime(outGain, t0, blendSec)
    inc.gain.gain.setValueAtTime(0.0, t0)
    inc.gain.gain.setValueCurveAtTime(incGain, t0, blendSec)

    // ── TRUE BASS SWAP ───────────────────────────────────────────────────────
    // outgoing bass → dead by t1
    out.lowEQ.gain.setValueAtTime(0, t0)
    out.lowEQ.gain.linearRampToValueAtTime(-40, t1)
    // incoming bass dead until t2, then rises in over the final 35%
    inc.lowEQ.gain.setValueAtTime(-40, t0)
    inc.lowEQ.gain.setValueAtTime(-40, t2)
    inc.lowEQ.gain.linearRampToValueAtTime(0, t4)

    // ── FILTER SWEEPS ────────────────────────────────────────────────────────
    // outgoing: HPF sweeps up 20 Hz → 800 Hz (progressive roll-off)
    out.hpf.frequency.setValueAtTime(20, t0)
    out.hpf.frequency.setValueCurveAtTime(_logCurve(CURVE_N, 20, 800), t0, blendSec)
    // incoming: HPF sweeps down 800 Hz → 20 Hz (filter opens as it arrives)
    inc.hpf.frequency.setValueAtTime(800, t0)
    inc.hpf.frequency.setValueCurveAtTime(_logCurve(CURVE_N, 800, 20), t0, blendSec)

    // ── HIGH + MID EQ BLEND ──────────────────────────────────────────────────
    // Outgoing highs fade by 6 dB over the blend — track gradually loses brightness
    const outHigh0 = out.highEQ.gain.value
    out.highEQ.gain.setValueAtTime(outHigh0, t0)
    out.highEQ.gain.setValueCurveAtTime(_sCurve(CURVE_N, t => outHigh0 - 6 * t), t0, blendSec)

    // Incoming highs start at -6 dB and open up — arrives "warm", gains sparkle
    inc.highEQ.gain.setValueAtTime(-6, now)
    inc.highEQ.gain.setValueAtTime(-6, t0)
    inc.highEQ.gain.setValueCurveAtTime(_sCurve(CURVE_N, t => -6 * (1 - t)), t0, blendSec)

    // Incoming mids start at -3 dB and restore to 0 by 60% — reduces clash at entry
    inc.midEQ.gain.setValueAtTime(-3, now)
    inc.midEQ.gain.setValueAtTime(-3, t0)
    inc.midEQ.gain.linearRampToValueAtTime(0, t0 + blendSec * 0.6)

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    const cleanup = t4 + 0.1
    out.lowEQ.gain.setValueAtTime(0, cleanup)
    out.highEQ.gain.setValueAtTime(0, cleanup)
    out.midEQ.gain.setValueAtTime(0, cleanup)
    out.hpf.frequency.setValueAtTime(20, cleanup)
    inc.hpf.frequency.setValueAtTime(20, cleanup)
    inc.highEQ.gain.setValueAtTime(0, cleanup)
    inc.midEQ.gain.setValueAtTime(0, cleanup)

    return {
      delayMs:    (t0 - now) * 1000,
      durationMs: blendSec * 1000,
    }
  }

  /** Find seconds until best transition start: prefers outro boundaries, else lowest-energy bar. */
  private _findTransitionPoint(deck: Deck, beatDur: number, blendBeats: number): number {
    const track  = deck.track!
    const pos    = deck.currentTime   // current position in track (seconds)
    const barDur = beatDur * 4

    // Prefer structural outro boundary if it's within the next 64 beats
    const outro = track.segments.find(s => s.label === "outro")
    if (outro && outro.start_s > pos && outro.start_s < pos + beatDur * 64) {
      const bars = Math.floor((outro.start_s - pos) / barDur)
      return Math.max(barDur, bars * barDur)
    }

    // Otherwise find the lowest-energy bar boundary in the next 8–16 bars
    const { energy_curve, duration_s } = track
    if (!energy_curve?.length) return this._nextPhraseBoundary(deck, 32)

    const searchEnd = Math.min(pos + barDur * 16, duration_s - blendBeats * beatDur)
    let bestDelay = barDur
    let lowestE   = Infinity

    for (let t = pos + barDur; t <= searchEnd; t += barDur) {
      const idx = Math.floor((t / duration_s) * energy_curve.length)
      const e   = energy_curve[Math.min(idx, energy_curve.length - 1)]
      if (e < lowestE) { lowestE = e; bestDelay = t - pos }
    }

    return bestDelay
  }

  private _nextPhraseBoundary(deck: Deck, beats: number): number {
    if (!deck.track) return 4
    const beatDur     = 60 / deck.track.bpm
    const currentBeat = Math.floor(deck.currentTime / beatDur)
    const next        = Math.ceil((currentBeat + 1) / beats) * beats
    return Math.max(0, next * beatDur - deck.currentTime)
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function _avgEnergy(track: TrackInfo): number {
  const c = track.energy_curve
  if (!c?.length) return 0.5
  return c.reduce((s, v) => s + v, 0) / c.length
}

function _findIntroCue(track: TrackInfo): number {
  return track.segments.find(s => s.label === "intro")?.start_s ?? 0
}

/** Float32Array where each sample applies ease-in-out then maps through fn(t ∈ 0–1). */
function _sCurve(n: number, fn: (t: number) => number): Float32Array {
  const arr = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t     = i / (n - 1)
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    arr[i]      = fn(eased)
  }
  return arr
}

/** Logarithmic interpolation from → to (for perceptually even frequency sweeps). */
function _logCurve(n: number, from: number, to: number): Float32Array {
  const arr = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    arr[i] = from * Math.pow(to / from, i / (n - 1))
  }
  return arr
}
