import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Proves the backpressure fix against a REAL Chromium RTCDataChannel, not
 * the in-memory fakes transfer.test.ts uses. The production bug ("send
 * queue is full") only ever manifested against a real browser's actual
 * internal send buffer — a fake channel can't reproduce that. 150 MiB at
 * the new 1 MiB high watermark means well over a hundred real backpressure
 * pause/resume cycles, which is what actually exercises the fix.
 */
test("transfers a large (150 MiB) file over a real DataChannel without backpressure failures", async ({ browser }) => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(path.join(tmpdir(), "fd9-e2e-large-"));
  const fixturePath = path.join(dir, "large.bin");
  const size = 150 * 1024 * 1024;

  // Write in streamed chunks rather than allocating the whole thing as one
  // in-memory buffer — keeps this test's own memory footprint bounded too.
  const hasher = createHash("sha256");
  const fd = openSync(fixturePath, "w");
  const chunkSize = 4 * 1024 * 1024;
  for (let written = 0; written < size; written += chunkSize) {
    const n = Math.min(chunkSize, size - written);
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

    // Must never hit a hard failure (the original "send queue is full" bug) on the way.
    const failedLocator = receiver.getByText(/failed|queue is full/i);

    await Promise.race([
      receiver.getByText("Files received").waitFor({ timeout: 90_000 }),
      failedLocator.waitFor({ timeout: 90_000 }).then(async () => {
        const text = await failedLocator.first().innerText().catch(() => "(unknown failure)");
        throw new Error(`Transfer reported a failure instead of completing: ${text}`);
      })
    ]);
    await expect(sender.getByText("Files sent")).toBeVisible({ timeout: 10_000 });

    const href = await receiver.locator("a[download]").getAttribute("href");
    const receivedHash = await receiver.evaluate(async (url) => {
      const res = await fetch(url as string);
      const buf = await res.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }, href);

    expect(receivedHash).toBe(expectedHash);
  } finally {
    await senderCtx.close();
    await receiverCtx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
