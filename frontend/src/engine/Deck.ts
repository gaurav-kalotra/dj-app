import { getAudioContext } from "./AudioEngine"
import type { TrackInfo } from "./types"

const API = "http://localhost:8888"

export class Deck {
  readonly id: string
  private ctx: AudioContext
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null

  // Signal chain: source → hpf → lowEQ → midEQ → highEQ → channelGain → faderGain → master
  readonly hpf:         BiquadFilterNode
  readonly lowEQ:       BiquadFilterNode
  readonly midEQ:       BiquadFilterNode
  readonly highEQ:      BiquadFilterNode
  readonly channelGain: GainNode   // user-controlled deck volume
  readonly gain:        GainNode   // crossfader-controlled — do not touch from UI

  private startedAt = 0
  private offsetAt  = 0
  private _playing  = false

  track: TrackInfo | null = null
  tempo = 1.0

  constructor(id: string, ctx: AudioContext, destination: AudioNode) {
    this.id  = id
    this.ctx = ctx

    this.hpf         = ctx.createBiquadFilter()
    this.lowEQ       = ctx.createBiquadFilter()
    this.midEQ       = ctx.createBiquadFilter()
    this.highEQ      = ctx.createBiquadFilter()
    this.channelGain = ctx.createGain()
    this.gain        = ctx.createGain()

    this.hpf.type      = "highpass"; this.hpf.frequency.value  = 20; this.hpf.Q.value = 0.7
    this.lowEQ.type    = "lowshelf"; this.lowEQ.frequency.value = 200
    this.midEQ.type    = "peaking";  this.midEQ.frequency.value = 1000; this.midEQ.Q.value = 1
    this.highEQ.type   = "highshelf";this.highEQ.frequency.value = 3000

    this.channelGain.gain.value = 1.0

    this.hpf.connect(this.lowEQ)
    this.lowEQ.connect(this.midEQ)
    this.midEQ.connect(this.highEQ)
    this.highEQ.connect(this.channelGain)
    this.channelGain.connect(this.gain)
    this.gain.connect(destination)
  }

  get playing() { return this._playing }

  get currentTime(): number {
    if (!this._playing) return this.offsetAt
    return this.offsetAt + (this.ctx.currentTime - this.startedAt) * this.tempo
  }

  async load(track: TrackInfo): Promise<void> {
    this.stop()
    this.track = track
    const res  = await fetch(`${API}/audio/${track.source_id}`)
    if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status}`)
    this.buffer = await this.ctx.decodeAudioData(await res.arrayBuffer())
    this.offsetAt = 0
    this.tempo = 1.0
  }

  play(offset?: number): void {
    if (!this.buffer) return
    this.stop()
    if (offset !== undefined) this.offsetAt = offset
    this.source = this.ctx.createBufferSource()
    this.source.buffer = this.buffer
    this.source.playbackRate.value = this.tempo
    this.source.connect(this.hpf)
    this.source.start(0, this.offsetAt)
    this.startedAt = this.ctx.currentTime
    this._playing  = true
    this.source.onended = () => {
      if (this._playing) { this.offsetAt = this.track?.duration_s ?? 0; this._playing = false }
    }
  }

  pause(): void {
    if (!this._playing) return
    this.offsetAt = this.currentTime
    this.source?.stop(); this.source = null; this._playing = false
  }

  stop(): void {
    try { this.source?.stop() } catch {}
    this.source = null; this._playing = false; this.offsetAt = 0
  }

  setTempo(rate: number): void {
    this.tempo = rate
    if (this.source) this.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.05)
  }

  setChannelGain(value: number): void {
    this.channelGain.gain.setTargetAtTime(Math.max(0, Math.min(2, value)), this.ctx.currentTime, 0.02)
  }

  setEQ(band: "low" | "mid" | "high", gainDb: number): void {
    const node = band === "low" ? this.lowEQ : band === "mid" ? this.midEQ : this.highEQ
    node.gain.setTargetAtTime(gainDb, this.ctx.currentTime, 0.05)
  }

  rampEQ(band: "low" | "mid" | "high", targetDb: number, durationSec: number): void {
    const node = band === "low" ? this.lowEQ : band === "mid" ? this.midEQ : this.highEQ
    node.gain.linearRampToValueAtTime(targetDb, this.ctx.currentTime + durationSec)
  }
}
