function concat(pieces: Uint8Array[], total: number): Uint8Array {
  if (pieces.length === 1) return pieces[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return out;
}

/**
 * Re-chunks a Blob/File's native stream (which yields arbitrarily-sized
 * pieces) into exact `chunkSize` pieces, so the wire protocol's frame size
 * is deterministic. Holds at most ~2x chunkSize in memory regardless of
 * file size — never buffers the whole file.
 */
export async function* readFixedSizeChunks(blob: Blob, chunkSize: number): AsyncGenerator<Uint8Array> {
  const reader = blob.stream().getReader();
  let buffered: Uint8Array[] = [];
  let bufferedLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        buffered.push(value);
        bufferedLength += value.byteLength;
        while (bufferedLength >= chunkSize) {
          const merged = concat(buffered, bufferedLength);
          yield merged.subarray(0, chunkSize);
          const rest = merged.subarray(chunkSize);
          buffered = rest.byteLength > 0 ? [rest] : [];
          bufferedLength = rest.byteLength;
        }
      }
      if (done) break;
    }
    if (bufferedLength > 0) {
      yield concat(buffered, bufferedLength);
    }
  } finally {
    reader.releaseLock();
  }
}
