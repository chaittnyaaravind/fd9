import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures/sample.txt");
const fixtureContent = readFileSync(fixturePath, "utf8");

/**
 * The decisive TURN test (spec section 5): both browser contexts are forced
 * into iceTransportPolicy "relay" via `?forceRelay=1`, so ICE can only use
 * TURN candidates — no direct/STUN path is allowed to succeed, even though
 * both contexts are on the same machine. If the file still transfers
 * byte-for-byte, the DataChannel genuinely worked over TURN relay, not just
 * "TURN candidates appeared in getStats()".
 *
 * Skipped unless E2E_TURN_CONFIGURED=1, because the local dev signaling
 * server has no TURN_URLS configured by default (see apps/signaling/.env.example)
 * — running this meaningfully requires pointing apps/signaling/.env at a real
 * TURN server (self-hosted coturn or Metered) first.
 */
test("forced relay-only ICE still transfers a file through TURN", async ({ browser }) => {
  test.skip(!process.env.E2E_TURN_CONFIGURED, "Set E2E_TURN_CONFIGURED=1 once apps/signaling/.env has real TURN_URLS configured.");

  const senderCtx = await browser.newContext();
  const receiverCtx = await browser.newContext();
  const sender = await senderCtx.newPage();
  const receiver = await receiverCtx.newPage();

  await sender.goto("/?forceRelay=1");
  await sender.getByRole("button", { name: /send files/i }).click();

  const chooserPromise = sender.waitForEvent("filechooser");
  await sender.locator(".dropzone").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fixturePath);

  const code = await sender.locator(".room-code").innerText();

  await receiver.goto("/?forceRelay=1");
  await receiver.getByRole("button", { name: /receive files/i }).click();
  await receiver.getByLabel("Room code").fill(code);
  await receiver.getByRole("button", { name: /join session/i }).click();

  // Prove relay is actually in use — not merely that candidates were gathered.
  await expect(sender.locator(".diag-row", { hasText: "TURN relay in use" })).toContainText("yes", { timeout: 15_000 });
  await expect(receiver.locator(".diag-row", { hasText: "TURN relay in use" })).toContainText("yes", { timeout: 15_000 });

  await expect(receiver.getByText("Incoming files")).toBeVisible({ timeout: 10_000 });
  await receiver.getByRole("button", { name: /^accept$/i }).click();

  await expect(receiver.getByText("Files received")).toBeVisible({ timeout: 20_000 });
  await expect(sender.getByText("Files sent")).toBeVisible({ timeout: 20_000 });

  const href = await receiver.locator("a[download]").getAttribute("href");
  const received = await receiver.evaluate(async (url) => {
    const response = await fetch(url as string);
    return response.text();
  }, href);

  expect(received).toBe(fixtureContent);

  await senderCtx.close();
  await receiverCtx.close();
});
