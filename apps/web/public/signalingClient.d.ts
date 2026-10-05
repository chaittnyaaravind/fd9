export interface SignalingMessage {
  type: string;
  [key: string]: unknown;
}

export declare class SignalingClient {
  readonly ws: WebSocket;
  constructor(url: string);
  onMessage(handler: (msg: SignalingMessage) => void): void;
  send(obj: Record<string, unknown>): void;
  waitOpen(): Promise<void>;
  waitFor(typeOrTypes: string | string[], timeoutMs?: number): Promise<SignalingMessage>;
}
