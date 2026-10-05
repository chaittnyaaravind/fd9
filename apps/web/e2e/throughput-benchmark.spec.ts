import { expect, test } from "@playwright/test";

/**
 * Phase 5 of the throughput audit, real-browser half: drives the EXACT
 * production send/receive path (SenderEngine/ReceiverEngine, real
 * RTCDataChannel, real OPFS writes) against the local dev server, using
 * benchmark mode's SyntheticChunkSource instead of a real file on disk —
 * so this can actually run 1-4 GiB "files" without the test itself paying
 * real disk I/O to create fixtures, and without the sandbox-network
 * limitations that make STUN/TURN unusable here (see connection-smoke.spec.ts):
 * this is two browser contexts on localhost, both using host candidates
 * only, which doesn't touch STUN/TURN at all.
 *
 * This measures the DATA PLANE correctly (real DataChannel, real OPFS
 * storage, real WASM hashing, real backpressure) — it does NOT measure
 * real cross-network conditions (that needs Test matrix step 8: real
 * Mac<->Android on the same LAN, which this sandbox cannot do). Treat the
 * numbers here as "is the pipeline itself correct and not pathologically
 * slow", not as a production throughput guarantee.
 */
const WEB_URL = process.env.FD9_BENCH_WEB_URL ?? "/";
const SIZES_MIB = (process.env.FD9_BENCH_SIZES_MIB ?? "10,256,1024,2048").split(",").map((s) => parseInt(s.trim(), 10));

interface BenchResult {
  sizeMiB: number;
  result: "PASS" | "FAIL";
  timeSec: number;
  avgMBs: number;
  peakInFlightBytes: number;
  peakPendingWrites: number;
  errorLocation: string;
}

const results: BenchResult[] = [];

test.afterAll(() => {
  console.log("\nSIZE(MiB)\tRESULT\tTIME(s)\tAVG MB/s\tMAX inFlight\tMAX pendingWrites\tERROR");
  for (const r of results) {
    console.log(`${r.sizeMiB}\t${r.result}\t${r.timeSec.toFixed(1)}\t${r.avgMBs.toFixed(1)}\t${r.peakInFlightBytes}\t${r.peakPendingWrites}\t${r.errorLocation}`);
  }
});

for (const sizeMiB of SIZES_MIB) {
  test(`benchmark mode: ${sizeMiB} MiB synthetic transfer completes correctly with bounded memory`, async ({ browser }) => {
    test.setTimeout(600_000);
    const sizeBytes = sizeMiB * 1024 * 1024;

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    let errorLocation = "";
    let peakInFlightBytes = 0;
    let peakPendingWrites = 0;
    let polling = true;

    async function poll() {
      while (polling) {
        try {
          const d = await receiver.evaluate(() => (window as unknown as { __fd9ReceiveDiagnostics?: { inFlightBytes: number; pendingWrites: number } }).__fd9ReceiveDiagnostics);
          if (d) {
            peakInFlightBytes = Math.max(peakInFlightBytes, d.inFlightBytes ?? 0);
            peakPendingWrites = Math.max(peakPendingWrites, d.pendingWrites ?? 0);
          }
        } catch {
          /* page mid-navigation — skip this tick */
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const pollDone = poll();

    const t0 = Date.now();
    let result: BenchResult["result"] = "FAIL";
    try {
      await sender.goto(WEB_URL);
      await sender.getByRole("button", { name: /send files/i }).click();
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
      await receiver.getByRole("button", { name: /^accept$/i }).click();

      const failedLocator = receiver.locator(".error-text, .banner.is-failed");
      const outcome = await Promise.race([
        receiver.getByText("Files received").waitFor({ timeout: 580_000 }).then(() => "received" as const),
        failedLocator.waitFor({ timeout: 580_000 }).then(() => "failed" as const)
      ]).catch(() => "timeout" as const);

      if (outcome === "received") {
        await expect(sender.getByText("Files sent")).toBeVisible({ timeout: 20_000 });
        result = "PASS";
      } else if (outcome === "failed") {
        errorLocation = await failedLocator.first().innerText().catch(() => "(unknown failure)");
      } else {
        errorLocation = `timeout — last diagnostics: inFlight=${peakInFlightBytes} pendingWrites=${peakPendingWrites}`;
      }
    } catch (err) {
      errorLocation = err instanceof Error ? err.message : String(err);
    } finally {
      polling = false;
      await pollDone;
      const elapsedSec = (Date.now() - t0) / 1000;
      results.push({
        sizeMiB,
        result,
        timeSec: elapsedSec,
        avgMBs: sizeBytes / (1024 * 1024) / elapsedSec,
        peakInFlightBytes,
        peakPendingWrites,
        errorLocation
      });
      await senderCtx.close();
      await receiverCtx.close();
    }

    expect(result, errorLocation).toBe("PASS");
    // The actual Phase 4/backpressure claim under test: received-but-
    // unwritten bytes stay bounded regardless of file size, same bound as
    // receiver-backpressure.test.ts's unit-level proof, now against a REAL
    // DataChannel + real OPFS instead of fakes.
    expect(peakInFlightBytes, `inFlightBytes grew unbounded at size=${sizeMiB}MiB`).toBeLessThan(64 * 1024 * 1024);
  });
}
