import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Targeted regression test for the reported hang: "1 GiB transfer passes,
 * ~1.6-1.8 GiB hangs" against the receiver's IndexedDB-backed fallback sink.
 * large-receive.spec.ts already proves 1 GiB works; this sweeps sizes that
 * bracket the reported failure zone against a REAL Chromium instance (real
 * RTCDataChannel, real IndexedDB — not the in-memory fakes transfer.test.ts
 * uses), and asserts the specific thing that used to run away unbounded:
 * inFlightBytes (received-but-not-yet-durably-written bytes on the
 * receiver) must stay bounded for the whole transfer, not grow with file
 * size.
 *
 * Default sizes bracket the reported hang (1.75 GiB, 2 GiB). Override with
 * FD9_MATRIX_SIZES_MIB="512,1024,1280,1536,1792,2048,3072,4096" to run the
 * full requested matrix — left as an env override rather than the default
 * because 3-4 GiB of random-byte generation + real disk I/O + a real
 * transfer is multiple minutes of wall-clock time per size; run that full
 * sweep on the actual target device, not just here.
 */
const SIZES_MIB = (process.env.FD9_MATRIX_SIZES_MIB ?? "1792,2048").split(",").map((s) => parseInt(s.trim(), 10));

interface SizeResult {
  sizeMiB: number;
  result: "PASS" | "FAIL" | "HANG";
  timeSec: number;
  avgMBs: number;
  peakMBs: number;
  maxInFlightBytes: number;
  maxPendingWrites: number;
  persistedBytes: number;
  finalFileSize: number;
  errorLocation: string;
}

const results: SizeResult[] = [];

test.afterAll(() => {
  console.log("\nSIZE(MiB)\tRESULT\tTIME(s)\tAVG MB/s\tPEAK MB/s\tMAX inFlight\tMAX pendingWrites\tPERSISTED\tFINAL SIZE\tERROR LOCATION");
  for (const r of results) {
    console.log(
      `${r.sizeMiB}\t${r.result}\t${r.timeSec.toFixed(1)}\t${r.avgMBs.toFixed(1)}\t${r.peakMBs.toFixed(1)}\t${r.maxInFlightBytes}\t${r.maxPendingWrites}\t${r.persistedBytes}\t${r.finalFileSize}\t${r.errorLocation}`
    );
  }
});

for (const sizeMiB of SIZES_MIB) {
  test(`receives a ${(sizeMiB / 1024).toFixed(2)} GiB (${sizeMiB} MiB) file without hanging, bounded receive-side memory`, async ({ browser }) => {
    test.setTimeout(900_000); // 15 min ceiling per size — generous vs. the reported "doesn't complete even after 5 min" hang
    const size = sizeMiB * 1024 * 1024;
    const dir = mkdtempSync(path.join(tmpdir(), "fd9-e2e-matrix-"));
    const fixturePath = path.join(dir, "big.bin");

    const hasher = createHash("sha256");
    const fd = openSync(fixturePath, "w");
    const writeChunk = 8 * 1024 * 1024;
    for (let written = 0; written < size; written += writeChunk) {
      const n = Math.min(writeChunk, size - written);
      const chunk = randomBytes(n);
      hasher.update(chunk);
      writeSync(fd, chunk);
    }
    closeSync(fd);
    const expectedHash = hasher.digest("hex");

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    let errorLocation = "";
    let maxInFlightBytes = 0;
    let maxPendingWrites = 0;
    let persistedBytes = 0;
    const samples: Array<{ t: number; bytesPersisted: number }> = [];
    let polling = true;

    async function poll() {
      while (polling) {
        try {
          const d = await receiver.evaluate(() => (window as unknown as { __fd9ReceiveDiagnostics?: Record<string, number> }).__fd9ReceiveDiagnostics);
          if (d) {
            maxInFlightBytes = Math.max(maxInFlightBytes, d.inFlightBytes ?? 0);
            maxPendingWrites = Math.max(maxPendingWrites, d.pendingWrites ?? 0);
            persistedBytes = d.bytesPersisted ?? persistedBytes;
            samples.push({ t: Date.now(), bytesPersisted: persistedBytes });
          }
        } catch {
          /* page may be mid-navigation between polls — skip this tick */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const pollDone = poll();

    const t0 = Date.now();
    let result: SizeResult["result"] = "FAIL";
    try {
      await sender.goto("/");
      await sender.getByRole("button", { name: /send files/i }).click();
      const chooserPromise = sender.waitForEvent("filechooser");
      await sender.locator(".dropzone").click();
      const chooser = await chooserPromise;
      await chooser.setFiles(fixturePath);
      const code = await sender.locator(".room-code").innerText();

      await receiver.goto("/");
      await receiver.getByRole("button", { name: /receive files/i }).click();
      await receiver.getByLabel("Room code").fill(code);
      await receiver.getByRole("button", { name: /join session/i }).click();
      await expect(receiver.getByText("Incoming files")).toBeVisible({ timeout: 10_000 });
      await receiver.getByRole("button", { name: /^accept$/i }).click();

      const failedLocator = receiver.locator(".error-text, .banner.is-failed");
      const outcome = await Promise.race([
        receiver.getByText("Files received").waitFor({ timeout: 870_000 }).then(() => "received" as const),
        failedLocator.waitFor({ timeout: 870_000 }).then(() => "failed" as const)
      ]).catch(() => "timeout" as const);

      if (outcome === "failed") {
        errorLocation = await failedLocator.first().innerText().catch(() => "(unknown failure)");
        result = "FAIL";
      } else if (outcome === "timeout") {
        errorLocation = `no progress / hang — last diagnostics: inFlight=${maxInFlightBytes} pendingWrites=${maxPendingWrites} persisted=${persistedBytes}`;
        result = "HANG";
      } else {
        await expect(sender.getByText("Files sent")).toBeVisible({ timeout: 20_000 });
        const href = await receiver.locator("a[download]").getAttribute("href");
        const receivedHash = await receiver.evaluate(async (url) => {
          const res = await fetch(url as string);
          const buf = await res.arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", buf);
          return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        }, href);
        if (receivedHash !== expectedHash) {
          errorLocation = "hash mismatch after completion";
          result = "FAIL";
        } else {
          result = "PASS";
        }
      }
    } catch (err) {
      errorLocation = err instanceof Error ? err.message : String(err);
      result = "FAIL";
    } finally {
      polling = false;
      await pollDone;
      const elapsedSec = (Date.now() - t0) / 1000;
      let peakMBs = 0;
      for (let i = 1; i < samples.length; i++) {
        const dt = (samples[i].t - samples[i - 1].t) / 1000;
        const db = samples[i].bytesPersisted - samples[i - 1].bytesPersisted;
        if (dt > 0 && db > 0) peakMBs = Math.max(peakMBs, db / (1024 * 1024) / dt);
      }
      results.push({
        sizeMiB,
        result,
        timeSec: elapsedSec,
        avgMBs: size / (1024 * 1024) / elapsedSec,
        peakMBs,
        maxInFlightBytes,
        maxPendingWrites,
        persistedBytes,
        finalFileSize: persistedBytes,
        errorLocation
      });
      await senderCtx.close();
      await receiverCtx.close();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(result, `size=${sizeMiB}MiB error=${errorLocation}`).toBe("PASS");
    // The actual fix under test: received-but-unwritten bytes must stay
    // bounded regardless of file size — not grow proportionally to it. 64
    // MiB is a generous multiple of the 16 MiB production high watermark
    // (allows for real browser scheduling jitter, not a tight bound).
    expect(maxInFlightBytes, `inFlightBytes grew unbounded at size=${sizeMiB}MiB`).toBeLessThan(64 * 1024 * 1024);
  });
}
