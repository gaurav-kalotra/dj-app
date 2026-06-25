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
  energy_curve: number[]   // normalised RMS, one value per ~0.5s window
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
  startBeat: number
  durationBeats: number
}

// ── WebSocket event shapes ────────────────────────────────────────────────────

export interface WsSessionState {
  event: "session_state"
  state: "idle" | "suggesting" | "playing" | "paused" | "stopped"
  outgoing_deck: DeckId
  deck_a: TrackInfo | null
  deck_b: TrackInfo | null
  narrative: string
}

export interface WsSuggestions {
  event: "suggestions"
  tracks: TrackInfo[]
  auto_pick_ms: number
}

export interface WsTrackQueued {
  event: "track_queued"
  deck: DeckId
  track: TrackInfo
  autoplay: boolean
}

export interface WsTransitionStart {
  event: "transition_start"
  outgoing: DeckId
  incoming: DeckId
}

export interface WsAgentFeed {
  event: "agent_feed"
  message: string
  ts: number
}

export interface WsRequestVerdict {
  event: "request_verdict"
  request_id: string
  query: string
  matched: { title: string; artist: string } | null
  verdict: "accepted" | "deferred" | "declined"
  slot_hint: string | null
  public_reason: string
  ts: number
}

export interface TrackRequest {
  id: string
  query: string
  requester: string | null
  matched_title: string | null
  matched_artist: string | null
  verdict: "pending" | "accepted" | "deferred" | "declined"
  slot_hint: string | null
  public_reason: string | null
  submitted_at: string
}
