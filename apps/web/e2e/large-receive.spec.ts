import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Proves the IndexedDB-backed receiver fallback actually removes the old
 * 1.5 GiB in-memory cap: this file is deliberately bigger than that cap.
 * Uses a receiver context with no real File System Access picker available
 * in headless automation, so it's guaranteed to exercise the fallback sink
 * — exactly the path that used to throw "exceeds the 1536 MiB limit."
 */
test("receives a file larger than the old 1.5 GiB in-memory cap via the IndexedDB fallback sink", async ({ browser }) => {
  test.setTimeout(360_000);
  const dir = mkdtempSync(path.join(tmpdir(), "fd9-e2e-bigrecv-"));
  const fixturePath = path.join(dir, "big.bin");
  const size = 1024 * 1024 * 1024;

  const hasher = createHash("sha256");
  const fd = openSync(fixturePath, "w");
  const chunkSize = 8 * 1024 * 1024;
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

    const t0 = Date.now();
    const failedLocator = receiver.locator(".error-text, .banner.is-failed");
    await Promise.race([
      receiver.getByText("Files received").waitFor({ timeout: 300_000 }),
      failedLocator.waitFor({ timeout: 300_000 }).then(async () => {
        const text = await failedLocator.first().innerText().catch(() => "(unknown)");
        throw new Error(`Receive failed instead of completing: ${text}`);
      })
    ]);
    await expect(sender.getByText("Files sent")).toBeVisible({ timeout: 20_000 });
    console.log(`transfer+receive completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

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
