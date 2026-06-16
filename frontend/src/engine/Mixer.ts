import { getAudioContext } from "./AudioEngine"
import { Deck } from "./Deck"
import type { DeckId, TrackInfo, TransitionPlan } from "./types"

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

    // Start with A at full volume, B silent
    this.deckA.gain.gain.value = 1.0
    this.deckB.gain.gain.value = 0.0
  }

  deck(id: DeckId): Deck {
    return id === "A" ? this.deckA : this.deckB
  }

  /**
   * Beat-matched transition: sync tempo of incoming to outgoing, then crossfade.
   * Uses EQ blend: outgoing bass fades out first, then full crossfade, incoming bass in last.
   */
  async transition(plan: TransitionPlan): Promise<void> {
    const out = this.deck(plan.outgoing)
    const inc = this.deck(plan.incoming)

    if (!out.track || !inc.track) return

    // Sync incoming tempo to match outgoing BPM
    const ratio = out.track.bpm / inc.track.bpm
    inc.setTempo(ratio)

    // Find the beat-aligned start time: next 32-beat boundary from now
    const beatStartSec = this._nextPhraseBoundary(out, plan.durationBeats)
    const beatDurSec   = (60 / out.track.bpm) * plan.durationBeats

    // Start incoming deck at its intro (cue point 0)
    inc.play(0)
    inc.gain.gain.value = 0

    const now = this.ctx.currentTime
    const t0  = now + beatStartSec          // transition start
    const t1  = t0 + beatDurSec * 0.25     // outgoing bass fades out (first quarter)
    const t2  = t0 + beatDurSec * 0.5      // main crossfade midpoint
    const t3  = t0 + beatDurSec * 0.75     // incoming bass fades in (last quarter)
    const t4  = t0 + beatDurSec            // transition complete

    // EQ blend: cut outgoing bass early, restore incoming bass late
    out.lowEQ.gain.linearRampToValueAtTime(-24, t1)   // outgoing bass out
    inc.lowEQ.gain.setValueAtTime(-24, t0)            // incoming bass starts cut
    inc.lowEQ.gain.linearRampToValueAtTime(0, t3)     // incoming bass in

    // Crossfade: linear equal-power approximation
    out.gain.gain.setValueAtTime(1.0, t0)
    out.gain.gain.linearRampToValueAtTime(0.0, t4)
    inc.gain.gain.setValueAtTime(0.0, t0)
    inc.gain.gain.linearRampToValueAtTime(1.0, t4)

    // Restore outgoing EQ after transition (cleanup)
    out.lowEQ.gain.setValueAtTime(0, t4 + 0.1)
  }

  /**
   * Real-time crossfader: 0 = full A, 1 = full B.
   *
   * Three layers of colour:
   *  1. Equal-power gain curve — no volume dip in the middle
   *  2. Hard bass kill — bass cuts to -40 dB starting at 30% from the fading side
   *  3. High-pass filter sweep — incoming track filters in from ~800 Hz,
   *     outgoing track filters out to ~800 Hz (classic DJ filter intro/outro)
   */
  setCrossfade(value: number): void {
    const v   = Math.max(0, Math.min(1, value))
    const now = this.ctx.currentTime
    const tau = 0.008  // fast but not zipper-noisy

    // Cancel any in-progress automation and anchor at current value
    // (cancelScheduledValues alone leaves the param at its scheduled destination;
    //  snapshot + setValueAtTime freezes it where it actually is right now)
    const snap = (p: AudioParam) => { const v = p.value; p.cancelScheduledValues(now); p.setValueAtTime(v, now) }
    snap(this.deckA.gain.gain);    snap(this.deckB.gain.gain)
    snap(this.deckA.lowEQ.gain);   snap(this.deckB.lowEQ.gain)
    snap(this.deckA.hpf.frequency);snap(this.deckB.hpf.frequency)

    // 1. Equal-power gain
    this.deckA.gain.gain.setTargetAtTime(Math.cos(v * Math.PI / 2), now, tau)
    this.deckB.gain.gain.setTargetAtTime(Math.sin(v * Math.PI / 2), now, tau)

    // 2. Bass kill — starts at 30% from each edge, full kill at the opposite edge
    const bassA = v < 0.3 ? 0 : -40 * Math.min((v - 0.3) / 0.7, 1)
    const bassB = v > 0.7 ? 0 : -40 * Math.min((0.7 - v) / 0.7, 1)
    this.deckA.lowEQ.gain.setTargetAtTime(bassA, now, tau)
    this.deckB.lowEQ.gain.setTargetAtTime(bassB, now, tau)

    // 3. HPF sweep — log scale 20 Hz (open) → 800 Hz (filtered)
    //    Deck A: open at v=0, filtered at v=1
    //    Deck B: filtered at v=0, open at v=1
    const hpfA = 20 * Math.pow(40, v)          // 20 Hz → 800 Hz
    const hpfB = 20 * Math.pow(40, 1 - v)      // 800 Hz → 20 Hz
    this.deckA.hpf.frequency.setTargetAtTime(hpfA, now, tau)
    this.deckB.hpf.frequency.setTargetAtTime(hpfB, now, tau)

    // Auto tempo sync: as soon as the fader moves past 5% toward a deck,
    // lock that deck's BPM to the other deck so it's ready to blend
    if (v > 0.05 && this.deckA.playing && this.deckB.track && !this.deckB.playing) {
      const ratio = this.deckA.track!.bpm / this.deckB.track.bpm
      this.deckB.setTempo(ratio)
    }
    if (v < 0.95 && this.deckB.playing && this.deckA.track && !this.deckA.playing) {
      const ratio = this.deckB.track!.bpm / this.deckA.track.bpm
      this.deckA.setTempo(ratio)
    }
  }

  /** Read actual crossfade position (0=A, 1=B) from live gain values. */
  getCrossfade(): number {
    const gainB = this.deckB.gain.gain.value
    // Inverse of sin(v * π/2) = gainB  →  v = asin(gainB) / (π/2)
    return Math.asin(Math.max(0, Math.min(1, gainB))) / (Math.PI / 2)
  }

  /** Match idle deck's tempo to playing deck. Call after loading a new track. */
  syncTempos(): void {
    if (this.deckA.playing && this.deckB.track) {
      this.deckB.setTempo(this.deckA.track!.bpm / this.deckB.track.bpm)
    } else if (this.deckB.playing && this.deckA.track) {
      this.deckA.setTempo(this.deckB.track!.bpm / this.deckA.track.bpm)
    }
  }

  /** Seconds until the next N-beat phrase boundary in the outgoing deck. */
  private _nextPhraseBoundary(deck: Deck, beats: number): number {
    if (!deck.track) return 4
    const beatDur   = 60 / deck.track.bpm
    const currentBeat = Math.floor(deck.currentTime / beatDur)
    const nextBoundary = Math.ceil((currentBeat + 1) / beats) * beats
    return Math.max(0, (nextBoundary * beatDur) - deck.currentTime)
  }
}
