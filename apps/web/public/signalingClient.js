// Minimal signaling-WebSocket client for apps/web/public/bench.js.
//
// FIX (see the Mac<->iPhone pairing investigation): the original inline
// version of this class had no message queue — a message arriving before
// the matching waitFor(type) call was registered was dropped permanently,
// not delayed. Both peers independently await their own
// request-turn-credentials round-trip before registering their
// waitFor("relay-sdp") listener; those two round-trips have no ordering
// guarantee relative to each other, so the faster peer's offer/answer can
// (and did, in a real cross-device test) arrive before the slower peer's
// listener existed, hanging that peer's setupConnection() until its own
// 60s timeout. This version queues any message that doesn't match a
// CURRENTLY-registered waiter or handler, and replays queued messages to
// a handler/waiter as soon as it registers — closing that race for both
// one-shot waits (waitFor) and permanent subscriptions (onMessage, used
// for relay-ice).
export class SignalingClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.handlers = []; // permanent subscribers (e.g. relay-ice)
    this.waiters = []; // one-shot { types, resolve, reject }
    this.queue = []; // messages not yet claimed by any waiter
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      for (const h of this.handlers) h(msg);
      const waiter = this.waiters.find((w) => w.types.includes(msg.type) || msg.type === "error");
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        if (msg.type === "error") waiter.reject(new Error(`signaling error: ${JSON.stringify(msg)}`));
        else waiter.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    };
  }

  /** Permanent subscriber — also immediately replayed any already-queued messages, so an early arrival isn't lost just because this was registered late. */
  onMessage(handler) {
    this.handlers.push(handler);
    for (const msg of this.queue) handler(msg);
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  waitOpen() {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.onopen = () => resolve();
    });
  }

  /** Accepts one type or an array of types. */
  waitFor(typeOrTypes, timeoutMs = 15000) {
    const types = Array.isArray(typeOrTypes) ? typeOrTypes : [typeOrTypes];
    const queuedIdx = this.queue.findIndex((m) => types.includes(m.type) || m.type === "error");
    if (queuedIdx !== -1) {
      const m = this.queue.splice(queuedIdx, 1)[0];
      if (m.type === "error") return Promise.reject(new Error(`signaling error: ${JSON.stringify(m)}`));
      return Promise.resolve(m);
    }
    return new Promise((resolve, reject) => {
      const waiter = { types, resolve: null, reject: null };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for [${types.join(",")}]`));
      }, timeoutMs);
      waiter.resolve = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
      waiter.reject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      this.waiters.push(waiter);
    });
  }
}
