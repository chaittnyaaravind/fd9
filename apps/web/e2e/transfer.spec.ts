import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures/sample.txt");
const fixtureContent = readFileSync(fixturePath, "utf8");

test("pairs two browser contexts and transfers a file byte-for-byte", async ({ browser }) => {
  const senderCtx = await browser.newContext();
  const receiverCtx = await browser.newContext();
  const sender = await senderCtx.newPage();
  const receiver = await receiverCtx.newPage();

  await sender.goto("/");
  await sender.getByRole("button", { name: /send files/i }).click();

  const chooserPromise = sender.waitForEvent("filechooser");
  await sender.getByRole("button", { name: /drop files here/i }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fixturePath);

  const code = await sender.locator(".room-code").innerText();
  expect(code).toMatch(/^[A-Z0-9]{4,8}$/);

  await receiver.goto("/");
  await receiver.getByRole("button", { name: /receive files/i }).click();
  await receiver.getByLabel("Room code").fill(code);
  await receiver.getByRole("button", { name: /join session/i }).click();

  await expect(receiver.getByText("Incoming files")).toBeVisible({ timeout: 10_000 });
  await receiver.getByRole("button", { name: /^accept$/i }).click();

  await expect(receiver.getByText("Files received")).toBeVisible({ timeout: 15_000 });
  await expect(sender.getByText("Files sent")).toBeVisible({ timeout: 15_000 });

  const href = await receiver.locator("a[download]").getAttribute("href");
  const received = await receiver.evaluate(async (url) => {
    const response = await fetch(url as string);
    return response.text();
  }, href);

  expect(received).toBe(fixtureContent);

  await senderCtx.close();
  await receiverCtx.close();
});

test("rejects joining with a nonexistent room code", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /receive files/i }).click();
  await page.getByLabel("Room code").fill("ZZZZZZ");
  await page.getByRole("button", { name: /join session/i }).click();

  await expect(page.getByText(/doesn't match an active session/i)).toBeVisible({ timeout: 10_000 });
});
