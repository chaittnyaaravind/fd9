export type TransferStatus =
  | "queued"
  | "transferring"
  | "paused"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

export interface FileProgress {
  fileIndex: number;
  name: string;
  size: number;
  mimeType: string;
  bytesMoved: number; // sender: bytes handed to the data channel; receiver: bytes written to the sink
  confirmedBytes: number; // sender: receiver-acked bytes; mirrors bytesMoved on the receiver
  status: TransferStatus;
  error?: string;
}

/**
 * Minimal structural slice of what the sender actually needs to read a
 * file's bytes — a real `Blob`/`File` already satisfies this (TypeScript
 * structural typing, no cast needed), but so can a synthetic, zero-real-I/O
 * generator (see benchmarkSource.ts). This is what makes benchmark mode
 * possible: swap the SOURCE, keep every other byte of the real send path
 * (framing, backpressure, hashing, acks) completely unchanged, so a
 * benchmark run measures the real pipeline, not a parallel mock of it.
 */
export interface ChunkReadable {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface SendableFile {
  fileIndex: number;
  name: string;
  size: number;
  mimeType: string;
  source: ChunkReadable;
}
