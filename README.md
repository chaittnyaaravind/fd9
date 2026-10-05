# Fd9

Share files from wherever, to whomever. Open the site on two devices, pair them with a QR code or a short code, and the files move directly between the browsers over a WebRTC data channel — never through a server.

## What this is

A TypeScript monorepo with three workspaces:

- **`packages/protocol`** — shared, zod-validated message schemas for both the signaling WebSocket protocol and the in-session data-channel control protocol, plus the binary chunk-framing codec. Both the server and the browser import the same types, so they can't drift out of sync.
- **`apps/signaling`** — a small Node.js WebSocket server (`ws`). It only exchanges connection setup information (SDP offers/answers, ICE candidates) between two paired browsers and mints short-lived TURN credentials. It never sees file names, file bytes, or transfer progress — those travel exclusively over the peer-to-peer WebRTC channel once established.
- **`apps/web`** — the React + Vite frontend: pairing UI, the file-transfer engine (chunked streaming reads, backpressure-aware sending, incremental SHA-256 hashing, streamed-to-disk or bounded-in-memory writing), and the visual design.

## Architecture

```
Browser A (sender)                Signaling server                Browser B (receiver)
      |  WebSocket  (create-room)       |                                 |
      |--------------------------------->|                                 |
      |  room code + QR (shareable link) |                                 |
      |<---------------------------------|                                 |
      |                                   |   WebSocket (join-room: code)  |
      |                                   |<--------------------------------|
      |  peer-joined                     |   joined                       |
      |<----------------------------------|-------------------------------->|
      |  SDP offer/answer + ICE (relayed via WebSocket)                    |
      |<--------------------------------->|<-------------------------------->|
      |                                                                     |
      |======================= WebRTC data channels =======================|
      |  "control" channel: JSON (file-offer, acks, pause/resume/cancel)   |
      |  "data" channel: binary chunk frames                                |
```

Two data channels are opened per session (negotiated up front, no renegotiation): a `control` channel carries small JSON messages (file metadata, accept/reject, pause/resume/cancel, chunk acknowledgements, the final integrity hash) and a `data` channel carries only binary chunk frames. Keeping them separate is what keeps the UI responsive — pause/cancel commands never have to wait behind a queue of in-flight file bytes.

### Diagnostics and the decisive TURN test

A hidden-by-default "Connection details" panel (click to expand, under the connection banner) shows real values read from `RTCPeerConnection`/`getStats()` — never inferred from `connectionState` alone: signaling state, ICE connection state, peer connection state, whether a candidate pair has actually been selected, the local/remote candidate types, whether TURN relay is actually in use, and the control/data channel `readyState`s.

Appending `?forceRelay=1` to the site URL forces `iceTransportPolicy: "relay"`, so ICE can only use TURN candidates — the decisive test that a relay genuinely carries a real file transfer, not just that TURN candidates were gathered. `apps/web/e2e/relay-only.spec.ts` automates exactly this.

### Transfer protocol

Each binary message on the data channel is one frame: `[fileIndex: u16][byteOffset: f64][length: u32][payload bytes]`. The sender reads a file through a small, fixed-size re-chunking generator (`readFixedSizeChunks`) built on `Blob.stream()`, so it never holds more than ~2 chunk-sizes of a file in memory regardless of file size. It computes a SHA-256 over the file incrementally (`@noble/hashes`, chunk at a time) and sends the final hex digest after the last chunk; the receiver computes its own incremental hash as bytes arrive and compares before declaring the file complete.

Backpressure uses the data channel's native `bufferedAmount`/`bufferedAmountLowThreshold`/`onbufferedamountlow` — the sender stops reading more of the file once buffered-but-unsent bytes exceed 4 MiB, and resumes once they drain below 1 MiB. This is the "bounded in-flight buffer" the spec asked for; it needed no additional queue on top.

Files are sent strictly one at a time (never interleaved) specifically so a paused or cancelled file can't corrupt another file's byte stream on the wire.

### Receiving large files

If the browser supports the File System Access API (Chrome, Edge — `showSaveFilePicker`/`showDirectoryPicker`), the receiver streams incoming bytes straight to a file on disk via `createWritable()`, with memory bounded to whatever's in flight on the wire. In browsers without that API (Firefox, Safari), it falls back to a bounded in-memory buffer (default cap: 1.5 GiB) and throws a clear, actionable error if a file would exceed it, rather than silently trying to hold an arbitrarily large Blob in memory.

### What the signaling server can and can't see

It can see: your IP address (for rate limiting), when rooms are created/joined/destroyed, and SDP/ICE metadata (which network paths are being tried — not file contents). It cannot see: file names, file contents, or transfer progress — those are end-to-end between the two browsers once the WebRTC connection is up. Room state is entirely in-memory and ephemeral: an unpaired room expires after 10 minutes, a paired session has a 30-minute hard cap.

A *paired* session survives a dropped signaling connection — the real scenario being a phone's Wi-Fi↔cellular handoff, which tears down the WebSocket's TCP connection even though the user never left. The room holds a 20-second grace window (`RECONNECT_GRACE_MS`) for the same peer to resume on a new WebSocket (`rejoin-room`), after which it's torn down and the other side is told the peer left for good. The browser's own `online`/`offline` events (near-instant on a real interface change) trigger reconnection immediately rather than waiting on the signaling heartbeat. Once resumed, the initiator issues a WebRTC ICE restart (`createOffer({iceRestart: true})`) if needed, and the sender re-sends whichever single file was actively in flight from scratch (sections below) since a torn-down SCTP association can silently drop already-"sent"-but-unflushed bytes — correctness over efficiency. A connection that can't be resumed is reported as failed, not silently pretended away.

## Local development

Requires Node 20+.

```bash
npm install
cp apps/signaling/.env.example apps/signaling/.env   # defaults work for local dev as-is
cp apps/web/.env.example apps/web/.env               # defaults work for local dev as-is

npm run dev:signaling   # starts ws://localhost:8787
npm run dev:web         # starts http://localhost:5173
```

Open `http://localhost:5173` in two browser tabs (or two devices on the same network, pointing `VITE_SIGNALING_URL` at your machine's LAN IP) — one picks "Send files", the other "Receive files" with the code shown.

## Tests

```bash
npm test          # protocol schema tests, signaling server unit tests, transfer-engine unit tests
npm run test:e2e -w apps/web   # real two-browser-context Playwright test (spins up both dev servers)
```

### What's actually verified (ran and passing)

- **`packages/protocol`** (15 tests): signaling/control message schema validation (accepts valid, rejects malformed/oversized/unknown-type messages), and binary chunk-frame encode/decode round-trips including an empty payload and an offset beyond 32 bits.
- **`apps/signaling`** (9 tests): room create/join/full/leave/destroy lifecycle, the waiting-room TTL expiring an unpaired room (and notifying the creator), a paired session surviving past that same TTL, and the rate limiter's fixed-window behavior across keys.
- **`apps/web`** unit tests (14 tests), driving the real `SenderEngine`/`ReceiverEngine` against an in-memory fake data channel (no browser needed):
  - byte-for-byte transfer of a text file
  - an empty (0-byte) file
  - two files with the **same name**, confirming both the on-screen dedupe (`notes.txt`, `notes (1).txt`) and that both arrive with correct, distinct content
  - pause mid-transfer, then resume, completing with correct bytes
  - cancel mid-transfer, confirming it never reports completion
  - backpressure: confirms the sender actually stops queuing once buffered bytes exceed the high watermark, and that a synchronous drain doesn't let a stale-microtask refill sneak past the assertion (a subtlety worth noting: `bufferedamountlow`'s resumed continuation runs on the next microtask, not synchronously)
- **`apps/web` Playwright E2E** (2 tests, two real `BrowserContext`s against the real signaling server and real `vite dev` build): pairing by code, approving a file offer, and fetching the receiver's resulting blob URL to assert it's byte-identical to the source fixture; and joining with a nonexistent code surfacing the actual "doesn't match an active session" error.
- **Manual, live, two-tab browser verification** (Chromium via the Playwright MCP tool, separately from the automated suite above): created a room, paired a second tab by code, watched the connection banner correctly report **"Connected directly, peer-to-peer"**, approved a real incoming-file dialog, and fetched the completed download link's bytes — confirmed identical to the uploaded file. This manual pass is what caught two real bugs before they shipped (see below) — the automated suites don't yet cover everything a live browser does (e.g. real user-gesture timing for file pickers).
- **Manual verification against the actual live deployment** (`https://fd9-web.vercel.app` ↔ Railway signaling), two real tabs: room creation, pairing by code, "Connected directly, peer-to-peer," file approval, and both sides reaching their completed state ("Files sent" / "Files received") with the receiver's integrity check passing. This is what caught the production-only bug described above (`packages/protocol`'s `main` field pointing at `.ts` source, which only worked locally because `tsx`/Vite can execute TypeScript directly — plain `node` in production can't). Separately noted: `showSaveFilePicker()` opens a genuine native OS dialog in a real (non-headless) browser, which this automation tooling can't click through the way a human would in ~1 second — not an app bug, just a limit of automating that specific browser API.

Two real bugs were found and fixed via that live run, not caught by the unit tests because they only manifest with real DOM event dispatch / real React 18 dev-mode behavior:
1. **`Dropzone`**: the hidden `<input type="file">` was a DOM child of the clickable wrapper `<div>`, so the programmatic `.click()` on it re-bubbled into the div's own `onClick`, causing runaway repeated file-picker opens. Fixed with `e.stopPropagation()` on the input's click handler.
2. **`CompletionScreen`**: the receiver's "Save" link uses `URL.createObjectURL`; the first implementation revoked and recreated these per-render in a way that React 18 StrictMode's dev-only mount→cleanup→remount cycle could invalidate before the user ever saw a working link. Fixed by giving each file its own local `useState`/`useEffect` pair (the textbook-correct pattern), rather than a shared "create once" map.

The network-blackout e2e test caught two more, both pre-existing and both masked until a file was large enough to actually exercise the data channel's send buffer:
3. **`SenderEngine`**: it sent `file-trailer` on the *control* channel as soon as the send loop finished calling `data.send()` for every chunk — not once the *data* channel had actually finished transmitting them. Control and data are separate SCTP streams with no ordering guarantee relative to each other, so for any file whose full byte count stays queued below the 16 MiB backpressure watermark (never triggering the per-chunk wait), the trailer could arrive and get hash-checked before all the bytes had. Fixed by waiting for `bufferedAmount` to drain to exactly 0 before sending the trailer (`waitForBufferedAmountZero()`).
4. **`finishSession`**: declaring the session "completed" the instant `session-complete` fired, when a just-resumed signaling connection's `peer-reconnected`/`rejoined` handler would *unconditionally* reset `phase` back to `"connected"`/`"connecting"` moments later — silently downgrading an already-finished, correctly-verified session back to the in-progress view. Fixed by making every reconnect-success path a no-op once `phase` is already terminal (`completed`/`failed`/`closed`).

A dedicated Playwright test (`apps/web/e2e/network-change.spec.ts`) proves the reconnect path against a *real* in-flight transfer, not just the signaling server's room-store logic in isolation: it forces a 3-second total network blackout on the receiving browser context mid-transfer (dropping its WebSocket and simulating a phone's Wi-Fi↔cellular handoff) and asserts the file still arrives byte-for-byte afterward. This is also what caught two real, previously-latent bugs (see below) that only a large enough file and a genuine connectivity interruption could expose.

### Not independently verified in this environment

- **TURN relay** specifically: `apps/web/e2e/relay-only.spec.ts` forces `iceTransportPolicy: "relay"` and proves a real file transfers through whatever TURN server `TURN_URLS` points at — but it's skipped unless `E2E_TURN_CONFIGURED=1`, because this environment's local dev signaling has no TURN configured by default. `buildIceServers` honestly reports `ttlSeconds: 0` and omits TURN entirely when unconfigured.
- **Cross-device / cross-network transfer** (the live tests are two tabs/contexts in one browser on one machine, which does exercise two separate `RTCPeerConnection`s and a real loopback network path, but not a real NAT traversal scenario).
- **Multi-gigabyte files** and the File System Access streaming-to-disk path specifically (the live demo used a 47-byte file; the in-memory-fallback path and bounded-memory behavior are covered by the streaming-chunk unit tests, but an actual multi-GB disk-write run wasn't performed here).
- Safari and Firefox (this environment only has Chromium available to drive interactively).
- Accessibility was built to spec (keyboard-operable dropzone, `aria-live` banner, focus-visible rings, `prefers-reduced-motion` handling) but not run through a screen reader.

## Production deployment

The signaling server needs a long-lived process (WebSocket connections), which rules out typical serverless/edge functions. Deploy it to anything that runs a persistent Node process — Railway, Fly.io, Render, or a small VM — and put it behind TLS so it's `wss://` in production (required by browsers once the frontend is served over HTTPS). The frontend (`apps/web`, a static Vite build) deploys anywhere static, e.g. Vercel, Netlify, or Cloudflare Pages.

### Live deployment

- **Web app:** https://fd9-web.vercel.app (Vercel, built from `apps/web` via the root `vercel.json`)
- **Signaling server:** `wss://fd9-signaling-production.up.railway.app` (Railway, persistent Node process)

Both npm-workspaces packages need the whole monorepo as build context (`apps/signaling` and `apps/web` both depend on `packages/protocol`), so each platform is configured to build from the repo root rather than a subdirectory:
- Railway auto-detects `build`/`start` from the root `package.json` (`npm run build` → compiles `packages/protocol` then `apps/signaling`; `npm run start` → `node apps/signaling/dist/server.js`). `ALLOWED_ORIGINS` is set to the Vercel domain above.
- Vercel uses the root `vercel.json` (`buildCommand: npm run build:web`, `outputDirectory: apps/web/dist`). `VITE_SIGNALING_URL` is set to the `wss://` Railway domain above.
- A root-level `postinstall` script (`npm run build -w packages/protocol`) exists specifically because `packages/protocol`'s `package.json` `main`/`types` point at its compiled `dist/` output, not `src/` — that's required for a plain `node dist/server.js` to run in production (unlike local dev, which uses `tsx`/Vite that can execute `.ts` directly). Forgetting this is exactly the bug that broke the first deploy attempt; `postinstall` guarantees `dist/` always exists right after any `npm install`, in any environment.

Required production configuration (if deploying your own instance):

- `ALLOWED_ORIGINS` on the signaling server — **set this**; an unset value accepts any Origin (fine for local dev, not for production).
- `VITE_SIGNALING_URL` on the frontend build, pointed at your `wss://` signaling host.

### TURN strategy: self-hosted coturn only, provider-agnostic

Fd9 deliberately uses **one** TURN strategy: a self-hosted, open-source [coturn](https://github.com/coturn/coturn) instance, not a managed/paid relay provider. Research into free public TURN options (Open Relay Project, rstream, Twilio trials, Xirsys) found none that are both genuinely anonymous *and* production-reliable — TURN inherently requires authentication to avoid being an abusable open relay, so "free + no-signup + production-grade" isn't a real combination. Self-hosting the open-source reference implementation, which this project already runs on Fly.io (`~/fd9-turn`), is the legitimate free/open answer.

`buildIceServers()` in `apps/signaling/src/turn.ts` is provider-agnostic by construction: it's driven entirely by `TURN_URLS` plus either `TURN_SECRET` (coturn's `use-auth-secret` HMAC scheme — short-lived credentials minted per session, matching the signaling server's `TURN_CREDENTIAL_TTL_SECONDS`) or `TURN_STATIC_USERNAME`/`TURN_STATIC_CREDENTIAL` (for any provider that hands out a fixed pair instead). Swapping to a different coturn instance, or even a different hosted provider later, is purely an environment-variable change — no code here needs to know which one it is. Nothing beyond the per-session credential ever reaches the browser; the shared secret stays server-side.

**Current status of the live deployment:** the self-hosted coturn (`fd9-turn.fly.dev`) serves TURN over UDP and TCP on port 3478 today. A `fly.toml` change is prepared (not yet deployed — pending Fly CLI auth) to add TURN/TLS on port 443 and plain TURN-over-TCP on port 80 by having Fly's edge terminate TLS and forward plaintext to the same coturn container — the standard way cloud TURN providers implement TURNS without the app needing its own certificate. This matters specifically for restrictive networks (campus/hotel/airport Wi-Fi) that block everything except 443. Until that's deployed, Fd9 falls back to STUN/direct only on networks that block UDP entirely to port 3478.

## Honest limitations

- No resume across a *closed tab* (that's still gone for good — there's no persistent storage to resume from). A dropped-but-recoverable connection (network change, brief ICE failure) *is* now handled — see above. Pause/resume *within* a live session works as before.
- The in-memory fallback (Safari/Firefox) caps a single file at 1.5 GiB by default; Chrome/Edge streaming to disk has no such cap.
- No background transfer: closing the tab or letting the phone's screen lock (if the Wake Lock request failed or isn't supported) stops the transfer. The UI says this up front rather than implying otherwise.
- Multiple simultaneous files transfer sequentially, not in parallel — a deliberate simplicity/correctness tradeoff, not a throughput ceiling we hit.

## Performance

Chunk size isn't guessed — once the data channel is open, `negotiatedMaxChunkSize()` reads the connection's real, negotiated `RTCSctpTransport.maxMessageSize` (both browsers' capabilities already reconciled) and sizes every chunk to the largest value that's actually safe for *this specific link*, bounded to [4 KiB, 256 KiB]. Where a browser doesn't expose that (older Firefox/Safari), it falls back to a 64 KiB default rather than the original 16 KiB — still conservative, but less so. Backpressure watermarks were raised to 16 MiB (high) / 4 MiB (low) so more can be pipelined in flight before the sender pauses, which matters most on higher-latency links.

What this deliberately does *not* do: fabricate a fixed throughput number. Real speed is bounded by both devices' hardware, the network path between them, and whether the connection ended up direct or TURN-relayed — none of which this code controls. No cross-network hardware was available in this environment to produce a trustworthy benchmark table, so none is presented as fact; the architecture above is the honest answer to "how fast is it," not a number pulled from nowhere.
