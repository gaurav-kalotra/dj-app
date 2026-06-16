import { useEffect, useRef, useState } from "react"
import type { Deck } from "../engine/Deck"
import type { TrackInfo } from "../engine/types"

interface Props {
  id: "A" | "B"
  deck: Deck
  library: TrackInfo[]
  isOutgoing: boolean
  onLoad: (track: TrackInfo) => void
}

export function DeckPanel({ id, deck, library, isOutgoing, onLoad }: Props) {
  const [playing, setPlaying]   = useState(false)
  const [position, setPosition] = useState(0)
  const [eq, setEq]             = useState({ low: 0, mid: 0, high: 0 })
  const panelRef                = useRef<HTMLDivElement>(null)
  const raf                     = useRef<number | null>(null)

  useEffect(() => {
    const tick = () => {
      setPlaying(deck.playing)
      setPosition(deck.currentTime)
      // Sync EQ sliders from the live audio graph so they reflect transition automation
      setEq(prev => {
        const snap = (v: number) => Math.round(v * 2) / 2  // round to 0.5 dB steps
        const low  = snap(deck.lowEQ.gain.value)
        const mid  = snap(deck.midEQ.gain.value)
        const high = snap(deck.highEQ.gain.value)
        if (low === prev.low && mid === prev.mid && high === prev.high) return prev
        return { low, mid, high }
      })
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [deck])

  const track = deck.track

  const handleLoad = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const t = library.find(t => t.source_id === e.target.value)
    if (t) onLoad(t)
  }

  const handlePlayPause = () => {
    if (deck.playing) { deck.pause(); setPlaying(false) }
    else { deck.play(); setPlaying(true) }
  }

  const handleEQ = (band: "low" | "mid" | "high", val: number) => {
    deck.setEQ(band, val)
    setEq(prev => ({ ...prev, [band]: val }))
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
  const pct = track ? (position / track.duration_s) * 100 : 0
  const borderColor = isOutgoing ? "#0f0" : "#252525"

  return (
    <div ref={panelRef} style={{ ...s.panel, borderColor }}>
      {/* Header */}
      <div style={s.deckLabel}>
        <span style={{ color: isOutgoing ? "#0f0" : "#444" }}>DECK {id}</span>
        {isOutgoing  && <span style={s.liveBadge}>LIVE</span>}
        {!isOutgoing && track && <span style={s.cuedBadge}>CUED</span>}
      </div>

      {/* Track selector */}
      <select style={s.select} onChange={handleLoad} defaultValue="">
        <option value="" disabled>— load track —</option>
        {library.map(t => (
          <option key={t.source_id} value={t.source_id}>
            {t.artist} — {t.title}
          </option>
        ))}
      </select>

      {/* Track info */}
      <div style={s.info}>
        {track ? (
          <>
            <div style={s.artist}>{track.artist}</div>
            <div style={s.title}>{track.title}</div>
            <div style={s.meta}>{track.bpm} BPM · {track.key} · {track.camelot}</div>
            <div style={s.time}>{fmt(position)} / {fmt(track.duration_s)}</div>
            <div style={s.progressBg}>
              <div style={{ ...s.progressFill, width: `${pct}%`, background: isOutgoing ? "#0f0" : "#333" }} />
            </div>
          </>
        ) : (
          <div style={s.empty}>no track loaded</div>
        )}
      </div>

      {/* Transport */}
      <div style={s.transport}>
        <button style={s.btn} onClick={handlePlayPause} disabled={!track}>
          {playing ? "⏸ PAUSE" : "▶ PLAY"}
        </button>
        <button style={s.btn} onClick={() => { deck.stop(); setPlaying(false) }} disabled={!track}>
          ■ STOP
        </button>
      </div>

      {/* EQ */}
      <div style={s.eqRow}>
        {(["high", "mid", "low"] as const).map(band => (
          <div key={band} style={s.eqCol}>
            <div style={s.eqLabel}>{band.toUpperCase()}</div>
            <input
              type="range" min={-24} max={6} step={0.5}
              value={eq[band]}
              onChange={e => handleEQ(band, Number(e.target.value))}
              style={s.eqSlider}
            />
            <div style={s.eqValue}>{eq[band] > 0 ? "+" : ""}{eq[band]}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  panel:      { width: 340, background: "#111", border: "1px solid", padding: 18, fontFamily: "monospace", boxSizing: "border-box", transition: "border-color 0.3s" },
  deckLabel:  { display: "flex", alignItems: "center", gap: 10, fontSize: 24, fontWeight: "bold", marginBottom: 14, letterSpacing: 5 },
  liveBadge:  { fontSize: 11, background: "#0f0", color: "#000", padding: "3px 7px", borderRadius: 2, letterSpacing: 1 },
  cuedBadge:  { fontSize: 11, background: "#252525", color: "#555", padding: "3px 7px", borderRadius: 2, letterSpacing: 1 },
  select:     { width: "100%", background: "#0d0d0d", color: "#aaa", border: "1px solid #252525", padding: "6px 8px", marginBottom: 12, fontFamily: "monospace", fontSize: 13 },
  info:       { minHeight: 100, marginBottom: 12 },
  artist:     { color: "#555", fontSize: 12 },
  title:      { color: "#ddd", fontSize: 15, fontWeight: "bold", marginBottom: 3 },
  meta:       { color: "#0a0", fontSize: 13, marginBottom: 3 },
  time:       { color: "#444", fontSize: 12, marginBottom: 6 },
  progressBg: { height: 4, background: "#1a1a1a", borderRadius: 2 },
  progressFill: { height: "100%", borderRadius: 2, transition: "none" },
  empty:      { color: "#2a2a2a", fontSize: 13, paddingTop: 24, textAlign: "center" },
  transport:  { display: "flex", gap: 8, marginBottom: 16 },
  btn:        { flex: 1, background: "#0d0d0d", color: "#666", border: "1px solid #222", padding: "8px 0", cursor: "pointer", fontFamily: "monospace", fontSize: 13 },

  eqRow:      { display: "flex", justifyContent: "space-around", gap: 10 },
  eqCol:      { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  eqLabel:    { color: "#333", fontSize: 11 },
  eqSlider:   { writingMode: "vertical-lr", direction: "rtl", width: 24, height: 90, cursor: "pointer", accentColor: "#0a0" },
  eqValue:    { color: "#444", fontSize: 11 },
}
