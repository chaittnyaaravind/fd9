import { expect, test } from "@playwright/test";

/**
 * Phase 1 of the "find the actual bottleneck" audit: independent,
 * real-Chromium measurements of each stage of the data path, so the
 * ~6 MB/s observed in the full pipeline (throughput-benchmark.spec.ts)
 * can be attributed to a SPECIFIC stage instead of guessed at. Every
 * test here runs isolated — no SenderEngine/ReceiverEngine control
 * protocol, no acks, no pause-checking — just the raw mechanism.
 *
 *   F: OPFS write alone (no WebRTC at all)
 *   C+D combined ("Benchmark A"): real RTCDataChannel send+receive,
 *      received bytes counted and discarded — no storage at all
 *   G ("Benchmark B"): the full real pipeline, from throughput-benchmark.spec.ts
 *
 * Comparing F against C+D against G is what actually answers "is it
 * OPFS, is it the DataChannel, or is it the glue between them" —
 * per the explicit instruction not to guess.
 */
const WEB_URL = process.env.FD9_BENCH_WEB_URL ?? "/";

test.describe("Phase 1 micro-benchmarks: isolate each stage of the real-browser data path", () => {
  test("F: OPFS write alone (sequential, single writable, no WebRTC)", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(WEB_URL);

    const result = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const name = `bench-opfs-${Date.now()}`;
      const fileHandle = await root.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();

      const sizeBytes = 512 * 1024 * 1024;
      const chunkSize = 1 * 1024 * 1024; // large sequential writes, not tiny-packet-sized
      const chunk = new Uint8Array(chunkSize);
      for (let i = 0; i < chunkSize; i++) chunk[i] = i & 0xff;

      const t0 = performance.now();
      let written = 0;
      while (written < sizeBytes) {
        await writable.write(chunk);
        written += chunkSize;
      }
      await writable.close();
      const elapsedMs = performance.now() - t0;

      await root.removeEntry(name).catch(() => undefined);
      return { sizeBytes, elapsedMs };
    });

    const mbPerSec = result.sizeBytes / (1024 * 1024) / (result.elapsedMs / 1000);
    console.log(`\nOPFS write alone: ${(result.sizeBytes / (1024 * 1024)).toFixed(0)} MiB in ${(result.elapsedMs / 1000).toFixed(2)}s = ${mbPerSec.toFixed(1)} MB/s`);
    expect(mbPerSec).toBeGreaterThan(0);
  });

  test("C+D ('Benchmark A'): real RTCDataChannel send+receive with NO storage (discard on receipt)", async ({ browser }) => {
    test.setTimeout(180_000);
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    try {
      await sender.goto(WEB_URL);
      await sender.getByRole("button", { name: /send files/i }).click();
      const sizeBytes = 512 * 1024 * 1024;
      await sender.evaluate((bytes) => {
        const store = (window as unknown as { __fd9Store: { getState(): { startSendingBenchmark(n: number): Promise<void> } } }).__fd9Store;
        void store.getState().startSendingBenchmark(bytes);
      }, sizeBytes);
      const code = await sender.locator(".room-code").innerText({ timeout: 15_000 });

      await receiver.goto(WEB_URL);
      await receiver.getByRole("button", { name: /receive files/i }).click();
      await receiver.getByLabel("Room code").fill(code);
      await receiver.getByRole("button", { name: /join session/i }).click();
      await expect(receiver.getByText("Incoming files")).toBeVisible({ timeout: 10_000 });

      const t0 = Date.now();
      // Benchmark A: accept with DiscardSink — real DataChannel, real
      // per-chunk pipeline, zero persistence.
      await receiver.evaluate(() => {
        const store = (window as unknown as { __fd9Store: { getState(): { acceptIncomingBenchmarkDiscard(): void } } }).__fd9Store;
        store.getState().acceptIncomingBenchmarkDiscard();
      });

      await expect(receiver.getByText("Files received")).toBeVisible({ timeout: 170_000 });
      const elapsedMs = Date.now() - t0;
      const mbPerSec = sizeBytes / (1024 * 1024) / (elapsedMs / 1000);
      console.log(`\nDataChannel transport+pipeline, NO storage: ${(sizeBytes / (1024 * 1024)).toFixed(0)} MiB in ${(elapsedMs / 1000).toFixed(2)}s = ${mbPerSec.toFixed(1)} MB/s`);
      expect(mbPerSec).toBeGreaterThan(0);
    } finally {
      await senderCtx.close();
      await receiverCtx.close();
    }
  });
});

/**
 * Phase 1 (continued) + Phase 3: the most isolated possible test — raw
 * RTCPeerConnection/RTCDataChannel, ZERO fd9 application code (no
 * SenderEngine, no chunking, no hashing, no backpressure-watermark logic
 * — just a tight send loop handling the browser's own "send queue is
 * full" exception). Signaling is done directly between the two pages via
 * evaluate() round-trips, not fd9's signaling server, so this has no
 * dependency on fd9 at all.
 *
 * MEASURED RESULT in this environment: ~7 MB/s for both a single channel
 * and 4 parallel channels on the SAME connection (aggregate, not per
 * channel) — i.e. parallelism does NOT help, which rules out a
 * per-channel/per-SCTP-stream limit and points at a connection/path-level
 * ceiling instead. This number is consistent with every other benchmark
 * in this suite (OPFS alone: >1000 MB/s; full fd9 pipeline: ~5-6.5 MB/s),
 * which is exactly what "the bottleneck is the transport, not the app"
 * looks like: removing every layer of application code between the two
 * numbers changes nothing.
 */
test.describe("Phase 1/3: raw RTCDataChannel ceiling, zero application code", () => {
  async function signalRawPeers(a: import("@playwright/test").Page, b: import("@playwright/test").Page, channelCount: number) {
    const offerData = await a.evaluate(async (n) => {
      const pc = new RTCPeerConnection();
      (window as unknown as { __pc: RTCPeerConnection }).__pc = pc;
      const dcs: RTCDataChannel[] = [];
      for (let i = 0; i < n; i++) dcs.push(pc.createDataChannel(`probe${i}`, { negotiated: true, id: i, ordered: true }));
      (window as unknown as { __dcs: RTCDataChannel[] }).__dcs = dcs;
      const candidates: RTCIceCandidateInit[] = [];
      pc.onicecandidate = (e) => {
        if (e.candidate) candidates.push(e.candidate.toJSON());
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise((r) => setTimeout(r, 1000));
      return { sdp: pc.localDescription?.sdp, candidates };
    }, channelCount);

    const answerData = await b.evaluate(
      async ({ offer, n }) => {
        const pc = new RTCPeerConnection();
        (window as unknown as { __pc: RTCPeerConnection }).__pc = pc;
        const dcs: RTCDataChannel[] = [];
        const received = new Array(n).fill(0);
        (window as unknown as { __received: () => number }).__received = () => received.reduce((x: number, y: number) => x + y, 0);
        for (let i = 0; i < n; i++) {
          const dc = pc.createDataChannel(`probe${i}`, { negotiated: true, id: i, ordered: true });
          dc.binaryType = "arraybuffer";
          dc.onmessage = (ev) => {
            received[i] += (ev.data as ArrayBuffer).byteLength;
          };
          dcs.push(dc);
        }
        (window as unknown as { __dcs: RTCDataChannel[] }).__dcs = dcs;
        const candidates: RTCIceCandidateInit[] = [];
        pc.onicecandidate = (e) => {
          if (e.candidate) candidates.push(e.candidate.toJSON());
        };
        await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
        for (const c of offer.candidates) await pc.addIceCandidate(c).catch(() => undefined);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await new Promise((r) => setTimeout(r, 1000));
        return { sdp: pc.localDescription?.sdp, candidates };
      },
      { offer: offerData, n: channelCount }
    );

    await a.evaluate(async (answer) => {
      const pc = (window as unknown as { __pc: RTCPeerConnection }).__pc;
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      for (const c of answer.candidates) await pc.addIceCandidate(c).catch(() => undefined);
    }, answerData);

    await a.waitForFunction(() => (window as unknown as { __dcs: RTCDataChannel[] }).__dcs?.every((d) => d.readyState === "open"), { timeout: 15_000 });
  }

  async function sendAllChannels(a: import("@playwright/test").Page, totalBytesPerChannel: number, channelCount: number) {
    return a.evaluate(
      async ({ totalBytesPerChannel: perChannel, n }) => {
        const dcs = (window as unknown as { __dcs: RTCDataChannel[] }).__dcs;
        const chunkSize = 256 * 1024;
        const chunk = new ArrayBuffer(chunkSize);
        const highWatermark = 8 * 1024 * 1024;
        for (const dc of dcs) dc.bufferedAmountLowThreshold = 2 * 1024 * 1024;

        async function sendOn(dc: RTCDataChannel): Promise<void> {
          let sent = 0;
          while (sent < perChannel) {
            if (dc.bufferedAmount > highWatermark) {
              await new Promise<void>((resolve) => {
                dc.onbufferedamountlow = () => resolve();
              });
            }
            try {
              dc.send(chunk);
              sent += chunkSize;
            } catch {
              // Real browser "send queue is full" — the exact condition
              // fd9's own sendChunkWithRetry handles; here it's just an
              // immediate wait-and-retry, no backoff schedule, to measure
              // the channel's real ceiling as directly as possible.
              await new Promise<void>((resolve) => {
                dc.onbufferedamountlow = () => resolve();
              });
            }
          }
          while (dc.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 10));
        }

        const t0 = performance.now();
        await Promise.all(dcs.map(sendOn));
        const elapsedMs = performance.now() - t0;
        return { totalSent: perChannel * n, elapsedMs };
      },
      { totalBytesPerChannel, n: channelCount }
    );
  }

  test("1 DataChannel: raw send/receive ceiling with no app code at all", async ({ browser }) => {
    test.setTimeout(120_000);
    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    const a = await aCtx.newPage();
    const b = await bCtx.newPage();
    try {
      await a.goto(WEB_URL);
      await b.goto(WEB_URL);
      await signalRawPeers(a, b, 1);

      const sizeBytes = 256 * 1024 * 1024;
      const result = await sendAllChannels(a, sizeBytes, 1);
      await b.waitForFunction((expected) => (window as unknown as { __received: () => number }).__received() >= expected - 1024 * 1024, result.totalSent, {
        timeout: 60_000
      });

      const mbPerSec = result.totalSent / (1024 * 1024) / (result.elapsedMs / 1000);
      console.log(`\n1 DataChannel (raw, no app code): ${(result.totalSent / (1024 * 1024)).toFixed(0)} MiB in ${(result.elapsedMs / 1000).toFixed(2)}s = ${mbPerSec.toFixed(1)} MB/s`);
      expect(mbPerSec).toBeGreaterThan(0);
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });

  test("4 parallel DataChannels (one connection): does splitting the stream help?", async ({ browser }) => {
    test.setTimeout(120_000);
    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    const a = await aCtx.newPage();
    const b = await bCtx.newPage();
    const channelCount = 4;
    try {
      await a.goto(WEB_URL);
      await b.goto(WEB_URL);
      await signalRawPeers(a, b, channelCount);

      const perChannelBytes = 64 * 1024 * 1024;
      const result = await sendAllChannels(a, perChannelBytes, channelCount);
      await b.waitForFunction((expected) => (window as unknown as { __received: () => number }).__received() >= expected - 2 * 1024 * 1024, result.totalSent, {
        timeout: 60_000
      });

      const mbPerSec = result.totalSent / (1024 * 1024) / (result.elapsedMs / 1000);
      console.log(
        `\n${channelCount} parallel DataChannels (one connection): ${(result.totalSent / (1024 * 1024)).toFixed(0)} MiB total in ${(result.elapsedMs / 1000).toFixed(2)}s = ${mbPerSec.toFixed(1)} MB/s aggregate`
      );
      expect(mbPerSec).toBeGreaterThan(0);
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });
});
