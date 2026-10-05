export interface ControlChannel {
  send(json: string): void;
  onMessage(handler: (json: string) => void): void;
  readonly readyState?: RTCDataChannelState;
}

/** Real, measured per-lane transport stats — never fabricated. A transport that can't produce one of these fields reports it as null rather than guessing. */
export interface TransportLaneStats {
  bytesSent: number;
  bytesReceived: number;
  rttMs: number | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  relayProtocol: string | null;
}

/**
 * The transport-lane contract (Milestone 1, item 3): the smallest interface
 * sender.ts/receiver.ts/TransportPool actually need from "one lane of bulk
 * data transfer" — deliberately NOT a copy of the RTCDataChannel API.
 * `RTCDataChannelAdapter` (rtc.ts) is the WebRTC implementation of this
 * contract; a future WebTransport or HTTP-stream lane would implement the
 * exact same shape without TransportPool/sender/receiver ever knowing the
 * difference. `getStats` is optional — not every transport can report every
 * field, and no existing test double needs to implement it.
 */
export interface DataChannel {
  send(buffer: ArrayBuffer): void;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onBufferedAmountLow(handler: () => void): void;
  onMessage(handler: (buffer: ArrayBuffer) => void): void;
  readonly readyState?: RTCDataChannelState;
  getStats?(): Promise<TransportLaneStats | null>;
}

/** Test double for ControlChannel: delivers to a linked peer on the next microtask. */
export class FakeControlChannel implements ControlChannel {
  private handler: ((json: string) => void) | null = null;
  private peer?: FakeControlChannel;

  link(peer: FakeControlChannel): void {
    this.peer = peer;
  }

  onMessage(handler: (json: string) => void): void {
    this.handler = handler;
  }

  send(json: string): void {
    queueMicrotask(() => this.peer?.handler?.(json));
  }
}

/**
 * Test double for DataChannel. With autoFlush (default), sends "arrive" on
 * the next microtask, like a fast loopback network. With autoFlush disabled,
 * sent buffers queue locally (bufferedAmount grows) until the test calls
 * `.flush()` — this is how the backpressure/pause-resume tests simulate a
 * slow receiver without needing real WebRTC.
 */
export class FakeDataChannel implements DataChannel {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  private lowHandler: (() => void) | null = null;
  private msgHandler: ((buffer: ArrayBuffer) => void) | null = null;
  private peer?: FakeDataChannel;
  private queue: ArrayBuffer[] = [];
  private failNextSendCount = 0;

  constructor(private readonly autoFlush = true) {}

  link(peer: FakeDataChannel): void {
    this.peer = peer;
  }

  /** Makes the next `count` calls to send() throw, simulating the browser's real "send queue is full" condition. */
  failNextSends(count: number): void {
    this.failNextSendCount = count;
  }

  onBufferedAmountLow(handler: () => void): void {
    this.lowHandler = handler;
  }

  onMessage(handler: (buffer: ArrayBuffer) => void): void {
    this.msgHandler = handler;
  }

  send(buffer: ArrayBuffer): void {
    if (this.failNextSendCount > 0) {
      this.failNextSendCount--;
      throw new Error("RTCDataChannel send queue is full");
    }
    this.bufferedAmount += buffer.byteLength;
    this.queue.push(buffer);
    if (this.autoFlush) {
      queueMicrotask(() => this.flush());
    }
  }

  /** Delivers up to `count` queued frames to the linked peer. */
  flush(count = Infinity): void {
    let delivered = 0;
    while (this.queue.length > 0 && delivered < count) {
      const buffer = this.queue.shift()!;
      this.bufferedAmount -= buffer.byteLength;
      delivered++;
      this.peer?.msgHandler?.(buffer);
    }
    if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.lowHandler?.();
    }
  }
}
