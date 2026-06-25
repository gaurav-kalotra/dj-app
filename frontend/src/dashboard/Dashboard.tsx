import { useEffect, useRef, useState } from "react"
import type { TrackInfo, TrackRequest, WsAgentFeed, WsRequestVerdict, WsSessionState, WsTrackQueued } from "../engine/types"
import { ws } from "../ws"

const API = "http://localhost:8888"
const MAX_FEED = 30

interface FeedItem { message: string; ts: number }

export function Dashboard() {
  const [connected, setConnected]     = useState(false)
  const [state, setState]             = useState("idle")
  const [nowPlaying, setNowPlaying]   = useState<TrackInfo | null>(null)
  const [requests, setRequests]       = useState<TrackRequest[]>([])
  const [feed, setFeed]               = useState<FeedItem[]>([])
  const [query, setQuery]             = useState("")
  const [requester, setRequester]     = useState("")
  const [submitting, setSubmitting]   = useState(false)
  const [submitMsg, setSubmitMsg]     = useState<{ text: string; ok: boolean } | null>(null)
  const feedRef                       = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`${API}/session`).then(r => r.json()).then((d) => {
      setState(d.state)
      setNowPlaying(d.now_playing)
    }).catch(() => {})

    fetch(`${API}/requests`).then(r => r.json()).then(setRequests).catch(() => {})
  }, [])

  useEffect(() => {
    ws.connect()

    const unsubs = [
      ws.on("session_state", (raw) => {
        const d = raw as unknown as WsSessionState
        setState(d.state)
        if (d.state === "idle" || d.state === "stopped") setNowPlaying(null)
      }),

      ws.on("track_queued", (raw) => {
        const d = raw as unknown as WsTrackQueued
        if (d.autoplay) setNowPlaying(d.track)
      }),

      ws.on("transition_start", (raw) => {
        const d = raw as Record<string, unknown>
        // incoming deck's track becomes now playing after transition
        setNowPlaying(prev => prev)  // will be updated by next track_queued autoplay
        void d
      }),

      ws.on("agent_feed", (raw) => {
        const d = raw as unknown as WsAgentFeed
        setFeed(prev => [...prev.slice(-(MAX_FEED - 1)), { message: d.message, ts: d.ts }])
      }),

      ws.on("request_verdict", (raw) => {
        const d = raw as unknown as WsRequestVerdict
        const req: TrackRequest = {
          id:             d.request_id,
          query:          d.query,
          requester:      null,
          matched_title:  d.matched?.title ?? null,
          matched_artist: d.matched?.artist ?? null,
          verdict:        d.verdict,
          slot_hint:      d.slot_hint,
          public_reason:  d.public_reason,
          submitted_at:   new Date(d.ts * 1000).toISOString(),
        }
        setRequests(prev => [req, ...prev.filter(r => r.id !== req.id)])
      }),

      ws.on("session_stopped", () => {
        setState("stopped")
        setNowPlaying(null)
      }),
    ]

    const pingInterval = setInterval(() => setConnected(ws.connected), 1000)
    setConnected(ws.connected)

    return () => {
      unsubs.forEach(u => u())
      clearInterval(pingInterval)
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim() || submitting) return
    setSubmitting(true)
    setSubmitMsg(null)
    try {
      const res = await fetch(`${API}/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), requester: requester.trim() || null }),
      })
      const data = await res.json()
      const verdict = data.verdict as string
      const msgs: Record<string, string> = {
        accepted: "Request accepted — it'll be weaved in soon.",
        deferred: "Request noted — queued for later when the energy fits.",
        declined: "Request declined. See reason below.",
      }
      setSubmitMsg({ text: msgs[verdict] ?? "Submitted.", ok: verdict !== "declined" })
      setQuery("")
    } catch {
      setSubmitMsg({ text: "Could not reach the DJ — try again.", ok: false })
    } finally {
      setSubmitting(false)
    }
  }

  const isPlaying = state === "playing" || state === "suggesting"

  return (
    <div style={s.root}>

      {/* Header */}
      <div style={s.header}>
        <span style={s.logo}>AXIOM</span>
        <span style={s.sub}>AUDIENCE DASHBOARD</span>
        <div style={s.headerRight}>
          <span style={{ ...s.statusDot, background: connected ? "#0f0" : "#333" }} />
          <span style={{ fontSize: 10, color: connected ? "#0f0" : "#444", letterSpacing: 1 }}>
            {connected ? "LIVE" : "connecting"}
          </span>
        </div>
      </div>

      {/* Now Playing */}
      <div style={s.nowPlayingBlock}>
        <div style={s.npLabel}>NOW PLAYING</div>
        {nowPlaying ? (
          <>
            <div style={s.npArtist}>{nowPlaying.artist}</div>
            <div style={s.npTitle}>{nowPlaying.title}</div>
            <div style={s.npMeta}>{nowPlaying.bpm} BPM · {nowPlaying.camelot} · {Math.floor(nowPlaying.duration_s / 60)}:{String(Math.round(nowPlaying.duration_s % 60)).padStart(2, "0")}</div>
          </>
        ) : (
          <div style={s.npEmpty}>
            {isPlaying ? "loading…" : "no session running"}
          </div>
        )}
      </div>

      {/* Request form */}
      <div style={s.section}>
        <div style={s.sectionLabel}>REQUEST A SONG</div>
        <form onSubmit={handleSubmit} style={s.form}>
          <input
            style={s.input}
            placeholder="artist name, track title, or vibe…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            disabled={submitting}
            autoComplete="off"
          />
          <input
            style={{ ...s.input, maxWidth: 160 }}
            placeholder="your name (optional)"
            value={requester}
            onChange={e => setRequester(e.target.value)}
            disabled={submitting}
            autoComplete="off"
          />
          <button style={{ ...s.submitBtn, opacity: submitting ? 0.5 : 1 }}
            type="submit" disabled={submitting}>
            {submitting ? "SUBMITTING…" : "SUBMIT REQUEST"}
          </button>
        </form>
        {submitMsg && (
          <div style={{ ...s.submitFeedback, color: submitMsg.ok ? "#0f0" : "#f44" }}>
            {submitMsg.text}
          </div>
        )}
      </div>

      {/* Requests list */}
      {requests.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionLabel}>REQUESTS</div>
          <div style={s.requestList}>
            {requests.map(r => (
              <div key={r.id} style={s.requestItem}>
                <div style={s.requestTop}>
                  <span style={s.requestQuery}>"{r.query}"</span>
                  {r.requester && <span style={s.requestBy}>— {r.requester}</span>}
                  <span style={{ ...s.verdictBadge, color: verdictColor(r.verdict) }}>
                    {r.verdict.toUpperCase()}
                  </span>
                </div>
                {r.matched_title && (
                  <div style={s.requestMatched}>matched: {r.matched_artist} — {r.matched_title}</div>
                )}
                {r.public_reason && (
                  <div style={s.requestReason}>{r.public_reason}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent log — always shown */}
      <div style={s.section}>
        <div style={s.sectionLabel}>AGENT LOG</div>
        <div ref={feedRef} style={s.feedScroll}>
          {feed.length === 0 ? (
            <div style={s.feedEmpty}>log appears when AUTO mode is active</div>
          ) : (
            [...feed].reverse().map((item, i) => (
              <div key={i} style={s.feedItem}>
                <span style={s.feedTime}>{new Date(item.ts * 1000).toLocaleTimeString()}</span>
                <span style={s.feedMsg}>{item.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={s.footer}>
        {state.toUpperCase()} · <a href="/" style={s.footerLink}>dj console →</a>
      </div>
    </div>
  )
}

function verdictColor(v: string) {
  if (v === "accepted") return "#0f0"
  if (v === "deferred") return "#fa0"
  if (v === "declined") return "#f44"
  return "#555"
}

const s: Record<string, React.CSSProperties> = {
  root:           { minHeight: "100vh", background: "#0a0a0a", color: "#ccc", fontFamily: "monospace", padding: "32px 40px", maxWidth: 760, margin: "0 auto" },

  header:         { display: "flex", alignItems: "center", gap: 16, marginBottom: 36, borderBottom: "1px solid #141414", paddingBottom: 16 },
  logo:           { fontSize: 28, fontWeight: "bold", color: "#0f0", letterSpacing: 6 },
  sub:            { fontSize: 10, letterSpacing: 4, color: "#444" },
  headerRight:    { marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 },
  statusDot:      { width: 7, height: 7, borderRadius: "50%" },

  nowPlayingBlock:{ marginBottom: 36, background: "#0d0d0d", border: "1px solid #1a1a1a", padding: "20px 24px" },
  npLabel:        { fontSize: 10, letterSpacing: 4, color: "#0a0", marginBottom: 12 },
  npArtist:       { fontSize: 13, color: "#666", marginBottom: 2 },
  npTitle:        { fontSize: 22, color: "#ddd", fontWeight: "bold", marginBottom: 8 },
  npMeta:         { fontSize: 11, color: "#444" },
  npEmpty:        { fontSize: 14, color: "#333" },

  section:        { marginBottom: 32 },
  sectionLabel:   { fontSize: 10, letterSpacing: 4, color: "#555", marginBottom: 10, borderBottom: "1px solid #111", paddingBottom: 6 },

  form:           { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "stretch" },
  input:          { flex: 1, background: "#0d0d0d", color: "#bbb", border: "1px solid #222", padding: "10px 12px", fontFamily: "monospace", fontSize: 12, outline: "none", minWidth: 160 },
  submitBtn:      { background: "#001800", color: "#0f0", border: "1px solid #0a0", padding: "10px 20px", cursor: "pointer", fontFamily: "monospace", fontSize: 11, letterSpacing: 2, flexShrink: 0, fontWeight: "bold" },
  submitFeedback: { fontSize: 12, marginTop: 10 },

  requestList:    { display: "flex", flexDirection: "column", gap: 8 },
  requestItem:    { background: "#0d0d0d", border: "1px solid #111", padding: "12px 16px" },
  requestTop:     { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 },
  requestQuery:   { fontSize: 13, color: "#aaa" },
  requestBy:      { fontSize: 11, color: "#444" },
  verdictBadge:   { fontSize: 10, letterSpacing: 2, marginLeft: "auto", flexShrink: 0, fontWeight: "bold" },
  requestMatched: { fontSize: 11, color: "#444", marginBottom: 3 },
  requestReason:  { fontSize: 12, color: "#555", fontStyle: "italic" },

  feedScroll:     { maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 },
  feedEmpty:      { fontSize: 12, color: "#2a2a2a", fontStyle: "italic" },
  feedItem:       { display: "flex", gap: 12, fontSize: 12 },
  feedTime:       { color: "#333", flexShrink: 0 },
  feedMsg:        { color: "#555" },

  footer:         { marginTop: 40, borderTop: "1px solid #0d0d0d", paddingTop: 12, fontSize: 11, color: "#2a2a2a" },
  footerLink:     { color: "#333", textDecoration: "none" },
}
