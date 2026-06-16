/** Singleton AudioContext — created on first user gesture to satisfy autoplay policy. */

let _ctx: AudioContext | null = null

export function getAudioContext(): AudioContext {
  if (!_ctx) {
    _ctx = new AudioContext()
  }
  if (_ctx.state === "suspended") {
    _ctx.resume()
  }
  return _ctx
}
