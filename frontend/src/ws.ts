const WS_URL = "ws://localhost:8888/ws"

type Listener = (data: Record<string, unknown>) => void

class WsClient {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Listener[]>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.ws = new WebSocket(WS_URL)
    this.ws.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data as string) as Record<string, unknown>
        const event = msg.event as string
        ;(this.listeners.get(event) ?? []).forEach(h => h(msg))
      } catch {}
    }
    this.ws.onclose = () => {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => this.connect(), 3000)
    }
    this.ws.onerror = () => this.ws?.close()
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
  }

  on(event: string, cb: Listener): () => void {
    const list = this.listeners.get(event) ?? []
    this.listeners.set(event, [...list, cb])
    return () => {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter(h => h !== cb))
    }
  }

  send(cmd: string, payload: Record<string, unknown> = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ cmd, ...payload }))
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

export const ws = new WsClient()
