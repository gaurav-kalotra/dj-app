import { useEffect, useRef, useState } from "react"
import { getAudioContext } from "../engine/AudioEngine"
import { Mixer } from "../engine/Mixer"
import type {
  DeckId, TrackInfo,
  WsSessionState, WsSuggestions, WsTrackQueued, WsTransitionStart, WsAgentFeed,
} from "../engine/types"
import { DeckPanel } from "./DeckPanel"
import { ws } from "../ws"

const API = "http://localhost:8888"

const SLIDER_H   = 420
const THUMB_R    = 8
const GAIN_TICKS = [150, 125, 100, 75, 50, 25, 0]
const MAX_FEED   = 60

interface FeedItem { message: string; ts: number }

export function Console() {
  const mixerRef                            = useRef<Mixer | null>(null)
  const crossfadeRef                        = useRef(0)
  const [library, setLibrary]               = useState<TrackInfo[]>([])
  const [outgoing, setOutgoing]             = useState<DeckId>("A")
  const [transitioning, setTransitioning]   = useState(false)
  const [userHoldsFader, setUserHoldsFader] = useState(false)
  const [crossfade, setCrossfade]           = useState(0)
  const [meterA, setMeterA]                 = useState(1)
  const [meterB, setMeterB]                 = useState(0)
  const [channelGainA, setChannelGainA]     = useState(100)
  const [channelGainB, setChannelGainB]     = useState(100)
  const [error, setError]                   = useState<string | null>(null)
  const [, forceUpdate]                     = useState(0)
  const rafRef                              = useRef<number | null>(null)

  // Auto mode state
  const [mode, setMode]                     = useState<"manual" | "auto">("manual")
  const [autoState, setAutoState]           = useState<string>("idle")
  const [narrative, setNarrative]           = useState<string>("")
  const [feedItems, setFeedItems]           = useState<FeedItem[]>([])
  const [suggestions, setSuggestions]       = useState<TrackInfo[] | null>(null)
  const [suggCountdown, setSuggCountdown]   = useState(0)
  const [seedId, setSeedId]                 = useState<string>("")

  // Keep crossfadeRef in sync for use inside WS callbacks
  crossfadeRef.current = crossfade

  useEffect(() => {
    fetch(`${API}/library`).then(r => r.json()).then((lib: TrackInfo[]) => {
      setLibrary(lib)
      if (lib.length > 0 && !seedId) setSeedId(lib[0].source_id)
    }).catch(e => setError(`Backend unreachable: ${e.message}`))
  }, [])

  useEffect(() => {
    const tick = () => {
      const m = mixerRef.current
      if (m) {
        setMeterA(m.deckA.gain.gain.value)
        setMeterB(m.deckB.gain.gain.value)
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])

  // ── Suggestion countdown ──────────────────────────────────────────────────
  useEffect(() => {
    if (!suggestions || suggCountdown <= 0) return
    const t = setTimeout(() => setSuggCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [suggestions, suggCountdown])

  // ── Auto mode WebSocket events ────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "auto") return
    ws.connect()

    const unsubs = [
      ws.on("session_state", (raw) => {
        const d = raw as unknown as WsSessionState
        setAutoState(d.state)
        setNarrative(d.narrative)
        setOutgoing(d.outgoing_deck)
      }),

      ws.on("track_queued", async (raw) => {
        const d = raw as unknown as WsTrackQueued
        const mixer = getMixer()
        await mixer.deck(d.deck).load(d.track)
        mixer.syncTempos()
        if (d.autoplay) {
          mixer.deck(d.deck).play()
          // Set crossfader to the playing deck's side
          const target = d.deck === "B" ? 1 : 0
          setCrossfade(target)
          crossfadeRef.current = target
          mixer.setCrossfade(target)
        }
        forceUpdate(n => n + 1)
      }),

      ws.on("transition_start", async (raw) => {
        const d = raw as unknown as WsTransitionStart
        setTransitioning(true)
        const mixer = getMixer()
        if (!mixer.deck(d.outgoing).playing) mixer.deck(d.outgoing).play()
        const { delayMs, durationMs } = await mixer.transition({
          outgoing: d.outgoing,
          incoming: d.incoming,
          startBeat: 0,
          durationBeats: 32,
        })
        // Report timing back to backend
        ws.send("transition_timing", { delay_ms: delayMs, duration_ms: durationMs })
        // Animate crossfader
        const start      = crossfadeRef.current
        const targetFader = d.incoming === "B" ? 1 : 0
        const animStart  = performance.now() + delayMs
        const animate    = () => {
          if (userHoldsFader) return
          const elapsed = performance.now() - animStart
          if (elapsed < 0) { requestAnimationFrame(animate); return }
          const t     = Math.min(elapsed / durationMs, 1)
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
          const val   = start + (targetFader - start) * eased
          setCrossfade(val)
          crossfadeRef.current = val
          if (t < 1) {
            requestAnimationFrame(animate)
          } else {
            setCrossfade(targetFader)
            crossfadeRef.current = targetFader
            setOutgoing(d.incoming)
            setTransitioning(false)
          }
        }
        requestAnimationFrame(animate)
      }),

      ws.on("suggestions", (raw) => {
        const d = raw as unknown as WsSuggestions
        setSuggestions(d.tracks)
        setSuggCountdown(Math.floor(d.auto_pick_ms / 1000))
      }),

      ws.on("agent_feed", (raw) => {
        const d = raw as unknown as WsAgentFeed
        setFeedItems(prev => [...prev.slice(-(MAX_FEED - 1)), { message: d.message, ts: d.ts }])
      }),

      ws.on("session_stopped", () => {
        setAutoState("idle")
        setSuggestions(null)
        setTransitioning(false)
      }),

      ws.on("error", (raw) => {
        setError((raw as { message: string }).message)
      }),
    ]

    return () => unsubs.forEach(u => u())
  }, [mode])

  // ── Helpers ───────────────────────────────────────────────────────────────

  const getMixer = (): Mixer => {
    if (!mixerRef.current) {
      getAudioContext()
      mixerRef.current = new Mixer()
    }
    return mixerRef.current
  }

  const handleLoad = (deckId: DeckId) => async (track: TrackInfo) => {
    const mixer = getMixer()
    await mixer.deck(deckId).load(track)
    mixer.syncTempos()
    forceUpdate(n => n + 1)
  }

  const handleChannelGain = (deckId: DeckId, pct: number) => {
    if (deckId === "A") { setChannelGainA(pct); getMixer().deckA.setChannelGain(pct / 100) }
    else                { setChannelGainB(pct); getMixer().deckB.setChannelGain(pct / 100) }
  }

  const handleFaderDown = () => setUserHoldsFader(true)
  const handleFaderUp   = () => setUserHoldsFader(false)

  const handleFader = (val: number) => {
    setCrossfade(val)
    crossfadeRef.current = val
    const mixer = getMixer()
    mixer.setCrossfade(val)
    if (val > 0.1 && mixer.deckB.track && !mixer.deckB.playing) {
      mixer.deckB.play(); forceUpdate(n => n + 1)
    }
    if (val < 0.9 && mixer.deckA.track && !mixer.deckA.playing) {
      mixer.deckA.play(); forceUpdate(n => n + 1)
    }
    if (val > 0.9) setOutgoing("B")
    if (val < 0.1) setOutgoing("A")
  }

  const handleAutoMix = async () => {
    const mixer    = getMixer()
    const incoming: DeckId = outgoing === "A" ? "B" : "A"
    if (!mixer.deck(outgoing).track) { setError("Load a track on the outgoing deck first."); return }
    if (!mixer.deck(incoming).track) { setError(`Load a track on Deck ${incoming} to mix into.`); return }
    setError(null)
    setTransitioning(true)
    if (!mixer.deck(outgoing).playing) mixer.deck(outgoing).play()
    const targetFader = incoming === "B" ? 1 : 0
    const { delayMs, durationMs } = await mixer.transition({ outgoing, incoming, startBeat: 0, durationBeats: 32 })
    if (!userHoldsFader) {
      const start     = crossfade
      const animStart = performance.now() + delayMs
      const animate   = () => {
        if (userHoldsFader) return
        const elapsed = performance.now() - animStart
        if (elapsed < 0) { requestAnimationFrame(animate); return }
        const t     = Math.min(elapsed / durationMs, 1)
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
        setCrossfade(start + (targetFader - start) * eased)
        if (t < 1) requestAnimationFrame(animate)
        else { setCrossfade(targetFader); setOutgoing(incoming) }
      }
      requestAnimationFrame(animate)
    } else {
      setOutgoing(incoming)
    }
    setTransitioning(false)
  }

  // ── Auto mode actions ─────────────────────────────────────────────────────

  const seedAndStart = () => {
    if (!seedId) return
    getMixer()  // unlock AudioContext
    ws.send("seed", { deck: "A", source_id: seedId })
    ws.send("start")
    setError(null)
    setFeedItems([])
  }

  const pickSuggestion = (track: TrackInfo) => {
    ws.send("select_suggestion", { source_id: track.source_id })
    setSuggestions(null)
  }

  const stopSession = () => {
    ws.send("stop")
  }

  const switchMode = (m: "manual" | "auto") => {
    if (m === mode) return
    if (m === "manual" && autoState === "playing") {
      ws.send("stop")
    }
    setMode(m)
    if (m !== "auto") ws.disconnect()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const mixer    = mixerRef.current
  const nowTrack = mixer ? mixer.deck(outgoing).track : null

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <span style={s.logo}>AXIOM</span>
        <div style={s.modeTabs}>
          <button style={{ ...s.modeTab, ...(mode === "manual" ? s.modeTabActive : {}) }}
            onClick={() => switchMode("manual")}>MANUAL</button>
          <button style={{ ...s.modeTab, ...(mode === "auto" ? s.modeTabActive : {}) }}
            onClick={() => switchMode("auto")}>AUTO</button>
        </div>
        {mode === "manual" && <span style={s.sub}>Manual Mode</span>}
        {mode === "auto"   && (
          <span style={{ ...s.sub, color: autoState === "playing" ? "#0f0" : "#555" }}>
            {autoState.toUpperCase()}
          </span>
        )}
      </div>

      {error && <div style={s.error}>{error}</div>}

      {/* ── MANUAL MODE controls ── */}
      {mode === "manual" && (
        <div style={s.nowPlaying}>
          <span style={s.npLabel}>NOW PLAYING</span>
          {nowTrack ? (
            <span style={s.npTrack}>
              <span style={s.npDeck}>{outgoing}</span>
              {nowTrack.artist} — {nowTrack.title}
              <span style={s.npMeta}>{nowTrack.bpm} BPM · {nowTrack.camelot}</span>
            </span>
          ) : (
            <span style={s.npEmpty}>nothing playing — load a track and press PLAY</span>
          )}
        </div>
      )}

      {/* ── AUTO MODE controls ── */}
      {mode === "auto" && (
        <div style={s.autoControls}>
          {autoState === "idle" || autoState === "stopped" ? (
            <div style={s.autoSeed}>
              <span style={s.autoLabel}>SEED TRACK</span>
              <select
                value={seedId}
                onChange={e => setSeedId(e.target.value)}
                style={s.seedSelect}
              >
                {library.map(t => (
                  <option key={t.source_id} value={t.source_id}>
                    {t.artist} — {t.title} ({t.bpm} BPM · {t.camelot})
                  </option>
                ))}
              </select>
              <button style={s.startBtn} onClick={seedAndStart}
                disabled={!seedId || library.length === 0}>
                ▶ START SESSION
              </button>
            </div>
          ) : (
            <div style={s.autoRunning}>
              <div style={s.nowPlaying}>
                <span style={s.npLabel}>NOW PLAYING</span>
                {nowTrack ? (
                  <span style={s.npTrack}>
                    <span style={s.npDeck}>{outgoing}</span>
                    {nowTrack.artist} — {nowTrack.title}
                    <span style={s.npMeta}>{nowTrack.bpm} BPM · {nowTrack.camelot}</span>
                  </span>
                ) : (
                  <span style={s.npEmpty}>loading…</span>
                )}
              </div>
              {narrative && <div style={s.narrative}>📖 {narrative}</div>}
              <button style={s.stopBtn} onClick={stopSession}>■ STOP SESSION</button>
            </div>
          )}
        </div>
      )}

      {/* ── Suggestions modal ── */}
      {suggestions && mode === "auto" && (
        <div style={s.suggOverlay}>
          <div style={s.suggPanel}>
            <div style={s.suggTitle}>
              PICK DECK B  <span style={s.suggTimer}>(auto in {suggCountdown}s)</span>
            </div>
            {suggestions.map(t => (
              <button key={t.source_id} style={s.suggItem} onClick={() => pickSuggestion(t)}>
                <span style={s.suggName}>{t.artist} — {t.title}</span>
                <span style={s.suggMeta}>{t.bpm} BPM · {t.camelot}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Deck area (shared between modes) ── */}
      <div style={s.decks}>
        {mixer ? (
          <>
            <div style={{ ...s.deckWrap, boxShadow: meterA > 0.5 ? "0 0 20px #0f03" : "none" }}>
              <SideStrip side="left" channelGain={channelGainA} meterGain={meterA}
                onGain={pct => handleChannelGain("A", pct)} />
              <DeckPanel id="A" deck={mixer.deckA} library={library}
                isOutgoing={outgoing === "A"} onLoad={handleLoad("A")} />
            </div>

            <div style={s.center}>
              <div style={s.faderSection}>
                <div style={s.faderLabels}>
                  <span style={{ color: crossfade < 0.4 ? "#0f0" : "#333", fontWeight: "bold" }}>A</span>
                  <span style={s.faderTitle}>CROSSFADER</span>
                  <span style={{ color: crossfade > 0.6 ? "#0f0" : "#333", fontWeight: "bold" }}>B</span>
                </div>
                <input
                  type="range" min={0} max={1} step={0.001}
                  value={crossfade}
                  onMouseDown={handleFaderDown}
                  onTouchStart={handleFaderDown}
                  onMouseUp={handleFaderUp}
                  onTouchEnd={handleFaderUp}
                  onChange={e => handleFader(Number(e.target.value))}
                  style={s.fader}
                />
                <div style={s.faderMid}>
                  <button style={s.centerBtn} onClick={() => handleFader(0.5)}>CENTER</button>
                </div>
              </div>

              <div style={s.divider} />

              {mode === "manual" && (
                <>
                  <button style={{ ...s.autoBtn, opacity: transitioning ? 0.4 : 1 }}
                    onClick={handleAutoMix} disabled={transitioning}>
                    {transitioning ? "MIXING…" : "⟹ AUTO MIX"}
                  </button>
                  <div style={s.hint}>32-beat beatmatched blend</div>
                  {transitioning && !userHoldsFader && (
                    <div style={s.overrideHint}>grab fader to override</div>
                  )}
                </>
              )}

              {mode === "auto" && autoState === "playing" && (
                <>
                  <div style={{ color: "#0f0", fontSize: 12, textAlign: "center", letterSpacing: 1 }}>
                    {transitioning ? "BLENDING…" : "AUTO RUNNING"}
                  </div>
                  <div style={s.hint}>grab fader to override</div>
                </>
              )}
            </div>

            <div style={{ ...s.deckWrap, boxShadow: meterB > 0.5 ? "0 0 20px #0f03" : "none" }}>
              <DeckPanel id="B" deck={mixer.deckB} library={library}
                isOutgoing={outgoing === "B"} onLoad={handleLoad("B")} />
              <SideStrip side="right" channelGain={channelGainB} meterGain={meterB}
                onGain={pct => handleChannelGain("B", pct)} />
            </div>
          </>
        ) : (
          <div style={s.startPrompt}>
            <button style={s.unlockBtn} onClick={() => { getMixer(); forceUpdate(n => n + 1) }}>
              ▶ START
            </button>
            <div style={s.hint}>unlocks AudioContext</div>
          </div>
        )}
      </div>

      {/* ── Agent feed ── */}
      <div style={s.feed}>
        <div style={s.feedTitle}>AGENT LOG</div>
        <div style={s.feedScroll}>
          {feedItems.length === 0 ? (
            <div style={{ color: "#2a2a2a", fontSize: 12, fontStyle: "italic" }}>
              {mode === "auto" ? "waiting for session…" : "switch to AUTO mode to see agent activity"}
            </div>
          ) : (
            [...feedItems].reverse().map((item, i) => (
              <div key={i} style={s.feedItem}>
                <span style={s.feedTime}>{new Date(item.ts * 1000).toLocaleTimeString()}</span>
                <span>{item.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={s.footer}>
        {library.length > 0 ? `${library.length} tracks in library` : "connecting to backend…"}
      </div>
    </div>
  )
}

// ─── Side strip ──────────────────────────────────────────────────────────────

function SideStrip({ side, channelGain, meterGain, onGain }: {
  side: "left" | "right"
  channelGain: number
  meterGain: number
  onGain: (pct: number) => void
}) {
  const nearestTick = GAIN_TICKS.reduce((best, val) =>
    Math.abs(val - channelGain) < Math.abs(best - channelGain) ? val : best
  )

  const labelTop = (val: number) =>
    THUMB_R + ((150 - val) / 150) * (SLIDER_H - 2 * THUMB_R)

  const labelsCol = (
    <div style={{ position: "relative", height: SLIDER_H, width: 34, flexShrink: 0 }}>
      {GAIN_TICKS.map(val => {
        const isExact   = channelGain === val
        const isNearest = val === nearestTick
        return (
          <button key={val} onClick={() => onGain(val)} style={{
            all: "unset",
            position: "absolute",
            top: labelTop(val),
            [side === "left" ? "right" : "left"]: 0,
            transform: "translateY(-50%)",
            fontSize: 10, fontFamily: "monospace", lineHeight: 1,
            color: isExact ? "#0f0" : isNearest ? "#484" : "#2a2a2a",
            textAlign: side === "left" ? "right" : "left",
            whiteSpace: "nowrap",
            cursor: "pointer",
            borderBottom: isExact ? "1px solid #0f0" : "1px solid transparent",
          }}>
            {val}
          </button>
        )
      })}
    </div>
  )

  const slider = (
    <input
      type="range" min={0} max={150} step={1}
      value={channelGain}
      onChange={e => onGain(Number(e.target.value))}
      style={{
        writingMode: "vertical-lr", direction: "rtl",
        height: SLIDER_H, width: 28,
        cursor: "pointer", accentColor: "#0f0",
        margin: 0, padding: 0, flexShrink: 0,
      }}
    />
  )

  const meter = <GainMeter gain={meterGain} />
  const inner = side === "left"
    ? <>{labelsCol}{slider}{meter}</>
    : <>{meter}{slider}{labelsCol}</>

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "8px 4px" }}>
      <div style={{ fontSize: 9, color: "#222", letterSpacing: 2, fontFamily: "monospace" }}>GAIN</div>
      <div style={{ fontSize: 12, color: "#0f0", fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
        {channelGain}%
      </div>
      <div style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", gap: 3 }}>
        {inner}
      </div>
    </div>
  )
}

function GainMeter({ gain }: { gain: number }) {
  const segments = Array.from({ length: 8 }, (_, i) => {
    const threshold = (i + 1) / 8
    const lit       = gain >= threshold
    const segColor  = threshold > 0.95 ? "#f00" : threshold > 0.75 ? "#ff0" : "#0f0"
    const segDark   = threshold > 0.95 ? "#200" : threshold > 0.75 ? "#220" : "#010"
    return { lit, color: lit ? segColor : segDark }
  })

  return (
    <div style={gm.wrap}>
      <div style={gm.label}>{Math.round(gain * 100)}%</div>
      <div style={gm.track}>
        {segments.reverse().map((seg, i) => (
          <div key={i} style={{ ...gm.seg, background: seg.color, boxShadow: seg.lit ? `0 0 4px ${seg.color}` : "none" }} />
        ))}
      </div>
    </div>
  )
}

const gm: Record<string, React.CSSProperties> = {
  wrap:  { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, alignSelf: "stretch", padding: "0 4px" },
  label: { color: "#252525", fontSize: 10, fontFamily: "monospace", writingMode: "vertical-lr", letterSpacing: 1 },
  track: { flex: 1, width: 18, display: "flex", flexDirection: "column", gap: 4, justifyContent: "flex-end" },
  seg:   { height: 0, flex: 1, borderRadius: 2, transition: "background 0.05s, box-shadow 0.05s" },
}

const s: Record<string, React.CSSProperties> = {
  root:         { minHeight: "100vh", background: "#0a0a0a", color: "#ccc", fontFamily: "monospace", padding: 32 },
  header:       { display: "flex", alignItems: "baseline", gap: 20, marginBottom: 16, borderBottom: "1px solid #141414", paddingBottom: 16 },
  logo:         { fontSize: 36, fontWeight: "bold", color: "#0f0", letterSpacing: 8 },
  sub:          { fontSize: 14, color: "#333", marginLeft: "auto" },
  modeTabs:     { display: "flex", gap: 2 },
  modeTab:      { background: "transparent", color: "#333", border: "1px solid #1c1c1c", padding: "4px 12px", cursor: "pointer", fontFamily: "monospace", fontSize: 11, letterSpacing: 2 },
  modeTabActive:{ color: "#0f0", borderColor: "#0a0", background: "#001400" },

  nowPlaying:   { display: "flex", alignItems: "center", gap: 16, background: "#0d0d0d", border: "1px solid #1a1a1a", padding: "14px 20px", marginBottom: 18 },
  npLabel:      { fontSize: 11, letterSpacing: 3, color: "#0f0", flexShrink: 0 },
  npTrack:      { display: "flex", alignItems: "center", gap: 10 },
  npDeck:       { background: "#0f0", color: "#000", fontWeight: "bold", fontSize: 13, padding: "2px 7px", borderRadius: 2 },
  npMeta:       { color: "#333", fontSize: 13 },
  npEmpty:      { color: "#333", fontSize: 13 },

  error:        { background: "#1a0000", border: "1px solid #500", color: "#f66", padding: "10px 14px", marginBottom: 14, fontSize: 13 },

  // Auto mode controls
  autoControls: { marginBottom: 18 },
  autoSeed:     { display: "flex", alignItems: "center", gap: 12, background: "#0d0d0d", border: "1px solid #1a1a1a", padding: "14px 20px" },
  autoLabel:    { fontSize: 11, letterSpacing: 3, color: "#555", flexShrink: 0 },
  seedSelect:   { flex: 1, background: "#0a0a0a", color: "#aaa", border: "1px solid #2a2a2a", padding: "6px 10px", fontFamily: "monospace", fontSize: 12, cursor: "pointer" },
  startBtn:     { background: "#001400", color: "#0f0", border: "1px solid #0a0", padding: "8px 18px", cursor: "pointer", fontFamily: "monospace", fontSize: 12, letterSpacing: 2, flexShrink: 0 },
  stopBtn:      { background: "#140000", color: "#f44", border: "1px solid #800", padding: "8px 18px", cursor: "pointer", fontFamily: "monospace", fontSize: 12, letterSpacing: 2, flexShrink: 0 },
  autoRunning:  { display: "flex", alignItems: "center", gap: 16, background: "#0d0d0d", border: "1px solid #1a1a1a", padding: "14px 20px", flexWrap: "wrap" },
  narrative:    { color: "#444", fontSize: 12, fontStyle: "italic", flex: 1 },

  // Suggestions modal
  suggOverlay:  { position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  suggPanel:    { background: "#0d0d0d", border: "1px solid #0a0", padding: 32, minWidth: 480, maxWidth: 600 },
  suggTitle:    { fontSize: 13, letterSpacing: 3, color: "#0f0", marginBottom: 20 },
  suggTimer:    { color: "#555", fontSize: 11 },
  suggItem:     { display: "flex", flexDirection: "column", gap: 4, width: "100%", background: "transparent", color: "#ccc", border: "1px solid #1c1c1c", padding: "12px 16px", cursor: "pointer", fontFamily: "monospace", marginBottom: 8, textAlign: "left" },
  suggName:     { fontSize: 13 },
  suggMeta:     { fontSize: 11, color: "#555" },

  decks:        { display: "flex", gap: 6, alignItems: "stretch", justifyContent: "center" },
  deckWrap:     { display: "flex", alignItems: "stretch", borderRadius: 4, transition: "box-shadow 0.3s" },

  center:       { display: "flex", flexDirection: "column", alignItems: "center", gap: 16, paddingTop: 48, width: 230 },
  faderSection: { width: "100%", display: "flex", flexDirection: "column", gap: 8 },
  faderLabels:  { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 18 },
  faderTitle:   { color: "#222", fontSize: 10, letterSpacing: 2 },
  fader:        { width: "100%", cursor: "pointer", accentColor: "#0f0", margin: 0, height: 6 },
  faderMid:     { display: "flex", justifyContent: "center" },
  centerBtn:    { background: "transparent", color: "#2a2a2a", border: "1px solid #1a1a1a", padding: "3px 10px", cursor: "pointer", fontFamily: "monospace", fontSize: 10, letterSpacing: 1 },
  divider:      { width: "100%", borderTop: "1px solid #141414" },
  autoBtn:      { background: "#001400", color: "#0f0", border: "1px solid #0a0", padding: "14px 0", cursor: "pointer", fontFamily: "monospace", fontSize: 13, letterSpacing: 2, width: "100%" },
  hint:         { color: "#222", fontSize: 11, textAlign: "center" },
  overrideHint: { color: "#0a0", fontSize: 11, textAlign: "center" },

  startPrompt:  { display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: 100 },
  unlockBtn:    { background: "#001400", color: "#0f0", border: "1px solid #0a0", padding: "18px 36px", cursor: "pointer", fontFamily: "monospace", fontSize: 18, letterSpacing: 4 },

  // Agent feed
  feed:         { marginTop: 24, borderTop: "1px solid #111", paddingTop: 12 },
  feedTitle:    { fontSize: 10, letterSpacing: 3, color: "#333", marginBottom: 8 },
  feedScroll:   { maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 },
  feedItem:     { display: "flex", gap: 10, fontSize: 12, color: "#3a3a3a" },
  feedTime:     { color: "#252525", flexShrink: 0 },

  footer:       { marginTop: 24, borderTop: "1px solid #111", paddingTop: 12, fontSize: 12, color: "#1a1a1a" },
}
