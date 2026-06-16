export interface BeatGrid {
  bpm: number
  beat_times: number[]   // seconds
  downbeats: number[]    // seconds
}

export interface Segment {
  label: "intro" | "body" | "outro" | string
  start_s: number
  end_s: number
}

export interface TrackInfo {
  source_id: string
  title: string
  artist: string
  genre: string | null
  bpm: number
  key: string
  camelot: string
  duration_s: number
  beat_grid: BeatGrid
  segments: Segment[]
}

export type DeckId = "A" | "B"

export interface DeckState {
  track: TrackInfo | null
  playing: boolean
  currentTime: number   // seconds
  tempo: number         // playback rate multiplier (1.0 = native BPM)
}

export interface TransitionPlan {
  outgoing: DeckId
  incoming: DeckId
  startBeat: number     // beat index in outgoing track to start transition
  durationBeats: number // length of crossfade in beats (default 32)
}
