import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFixedSizeChunks } from "../src/lib/transfer/chunking.js";
import { dedupeFilenames, sanitizeFilename } from "../src/lib/transfer/filenames.js";
import { IncrementalHasher } from "../src/lib/transfer/hashing.js";

describe("IncrementalHasher", () => {
  it("matches Node's sha256 for chunked input", async () => {
    const data = new TextEncoder().encode("hello world, this is a reasonably sized test payload".repeat(10));
    const hasher = new IncrementalHasher();
    for (let i = 0; i < data.length; i += 7) await hasher.update(data.subarray(i, i + 7));

    const expected = createHash("sha256").update(data).digest("hex");
    expect(await hasher.digestHex()).toBe(expected);
  });

  it("produces the same hash as Node for empty input", async () => {
    const hasher = new IncrementalHasher();
    const expected = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    expect(await hasher.digestHex()).toBe(expected);
  });
});

describe("sanitizeFilename", () => {
  it("strips path separators and leading dots", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
  });
  it("falls back to a default name for an empty/dot-only name", () => {
    expect(sanitizeFilename("...")).toBe("unnamed-file");
  });
});

describe("dedupeFilenames", () => {
  it("suffixes duplicates while preserving extensions", () => {
    expect(dedupeFilenames(["a.txt", "a.txt", "a.txt"])).toEqual(["a.txt", "a (1).txt", "a (2).txt"]);
  });
  it("leaves unique names untouched", () => {
    expect(dedupeFilenames(["a.txt", "b.txt"])).toEqual(["a.txt", "b.txt"]);
  });
});

describe("readFixedSizeChunks", () => {
  it("re-chunks an arbitrary stream into exact sizes", async () => {
    const data = new Uint8Array(37).map((_, i) => i);
    const blob = new Blob([data]);
    const chunks: Uint8Array[] = [];
    for await (const chunk of readFixedSizeChunks(blob, 10)) chunks.push(chunk);

    expect(chunks.map((c) => c.byteLength)).toEqual([10, 10, 10, 7]);
    const rejoined = new Uint8Array(37);
    let offset = 0;
    for (const c of chunks) {
      rejoined.set(c, offset);
      offset += c.byteLength;
    }
    expect(Array.from(rejoined)).toEqual(Array.from(data));
  });

  it("yields nothing for an empty blob", async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of readFixedSizeChunks(new Blob([]), 10)) chunks.push(chunk);
    expect(chunks).toEqual([]);
  });
});
