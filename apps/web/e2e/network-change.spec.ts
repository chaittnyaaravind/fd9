import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Proves the reconnect/ICE-restart feature (spec section 15) actually
 * recovers a real in-flight transfer, not just that the signaling server's
 * room-store logic is correct in isolation (see rooms.test.ts for that).
 *
 * A ~6 MiB file is large enough that a brief `setOffline` blackout on the
 * receiver's context — which drops its WebSocket *and* its WebRTC
 * connectivity simultaneously, standing in for a phone's Wi-Fi<->cellular
 * handoff — lands mid-transfer. The assertion that matters is the final
 * one: the file still arrives byte-for-byte after the blackout ends.
 */
test("recovers an in-flight transfer after a simulated network blackout", async ({ browser }) => {
  test.setTimeout(60_000);
  const dir = mkdtempSync(path.join(tmpdir(), "fd9-e2e-"));
  const fixturePath = path.join(dir, "big.bin");
  const content = randomBytes(6 * 1024 * 1024);
  writeFileSync(fixturePath, content);
  const expectedHash = createHash("sha256").update(content).digest("hex");

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

    // Let bytes actually start flowing before yanking the network.
    await expect(receiver.locator(".diag-row", { hasText: "Data channel" })).toContainText("open", { timeout: 10_000 });
    await sender.waitForTimeout(400);

    await receiverCtx.setOffline(true);
    await sender.waitForTimeout(3000); // long enough for both sides to notice and start recovering
    await receiverCtx.setOffline(false);

    await expect(receiver.getByText("Files received")).toBeVisible({ timeout: 30_000 });
    await expect(sender.getByText("Files sent")).toBeVisible({ timeout: 30_000 });

    const href = await receiver.locator("a[download]").getAttribute("href");
    const receivedHash = await receiver.evaluate(async (url) => {
      const response = await fetch(url as string);
      const buffer = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }, href);

    expect(receivedHash).toBe(expectedHash);
  } finally {
    await senderCtx.close();
    await receiverCtx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
