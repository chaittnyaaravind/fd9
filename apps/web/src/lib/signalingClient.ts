import { clientMessageSchema, serverMessageSchema, type ClientMessage, type ServerMessage } from "@fd9/protocol";

export type SignalingState = "connecting" | "open" | "closed";

/**
 * Thin, validated wrapper around the signaling WebSocket. No reconnect logic
 * by design — a dropped signaling connection mid-session means the peer
 * connection is gone too, and we surface that honestly rather than pretend
 * to resume (see README's "no reconnection" limitation).
 */
export class SignalingClient {
  private ws: WebSocket;
  private messageHandlers = new Set<(msg: ServerMessage) => void>();
  private stateHandlers = new Set<(state: SignalingState) => void>();
  state: SignalingState = "connecting";

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => this.setState("open"));
    this.ws.addEventListener("close", () => this.setState("closed"));
    this.ws.addEventListener("error", () => this.setState("closed"));
    this.ws.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const result = serverMessageSchema.safeParse(parsed);
      if (!result.success) return;
      for (const handler of this.messageHandlers) handler(result.data);
    });
  }

  private setState(state: SignalingState): void {
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  onMessage(handler: (msg: ServerMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: (state: SignalingState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  send(message: ClientMessage): void {
    clientMessageSchema.parse(message); // fail loudly in dev if we ever construct a bad message
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }
}
