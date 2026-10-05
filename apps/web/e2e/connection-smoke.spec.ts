import { expect, test, type Page } from "@playwright/test";

/**
 * Minimal WebRTC connectivity smoke test — deliberately independent of
 * EVERY app module (ReceiverEngine/SenderEngine, sinks.ts/IndexedDB,
 * backpressure, chunking). It reimplements only the bare signaling+ICE+
 * DataChannel handshake as plain browser APIs inside page.evaluate(), wired
 * directly against the REAL DEPLOYED signaling server
 * (wss://fd9-signaling-production.up.railway.app) — not localhost — so it
 * exercises the actual production signaling + TURN-credential-minting path
 * a real device pairing goes through.
 *
 * Both browser contexts run on this one machine/network, so this CANNOT
 * reproduce genuine cross-NAT behavior the way a real Mac<->Android pairing
 * does — direct/srflx connectivity between two contexts on the same LAN
 * isn't a meaningful test of "C) direct host/srflx connectivity between
 * different networks". What it DOES conclusively answer, against the real
 * production backend:
 *   A) signaling              — create-room/join-room/relay-sdp/relay-ice
 *   B) ICE candidate exchange — candidates reach the other side, get accepted
 *   D) TURN relay connectivity — forced iceTransportPolicy:"relay" with the
 *      REAL prod TURN credentials: does a DataChannel reach OPEN over TURN?
 *   E) DataChannel establishment — does ping/pong flow once ICE connects?
 *
 * Every lifecycle transition (signalingState, iceGatheringState,
 * iceConnectionState, connectionState, selected candidate pair + types,
 * TURN-in-use, DataChannel readyState, ICE candidate errors) is logged.
 */

const SIGNALING_URL = process.env.FD9_SMOKE_SIGNALING_URL ?? "wss://fd9-signaling-production.up.railway.app";
const WEB_URL = process.env.FD9_SMOKE_WEB_URL ?? "https://fd9-web.vercel.app";

interface SmokeResult {
  ok: boolean;
  failedAt: string | null;
  log: string[];
  final: {
    signalingState: string;
    iceGatheringState: string;
    iceConnectionState: string;
    connectionState: string;
    dataChannelReadyState: string;
    selectedPair: { localType: string | null; remoteType: string | null; localProtocol: string | null; remoteProtocol: string | null } | null;
    turnInUse: boolean;
    iceCandidateErrors: string[];
  };
}

/**
 * Injected into the page via page.evaluate() — must be fully self-contained
 * (no references to anything outside this function's own body/closure).
 * The offerer reports its room code to Node via `window.__smokeReportRoomCode`
 * (wired with page.exposeFunction) since a function reference can't be
 * passed through evaluate()'s argument.
 */
async function runSmokeInBrowser(opts: {
  signalingUrl: string;
  role: "offerer" | "answerer";
  roomCode: string | null;
  forceRelay: boolean;
  /**
   * Test B/C per the acceptance criteria: filters the server-minted TURN
   * urls down to only the transport(s) under test, so a connection can only
   * succeed via that specific path. "udp-only" forces TURN/UDP (simulating
   * direct connectivity having failed, per Test B); "tcp-tls-only" forces
   * TURN/TCP or TURN/TLS-443 (simulating UDP itself being blocked, per Test
   * C) — exactly the restrictive-network scenario the 443 fallback exists
   * for. null (Test A) uses every url unfiltered.
   */
  transportFilter: "udp-only" | "tcp-tls-only" | null;
  timeoutMs: number;
}): Promise<SmokeResult> {
  const log: string[] = [];
  const iceCandidateErrors: string[] = [];
  const t0 = Date.now();
  const line = (s: string) => log.push(`+${Date.now() - t0}ms [${opts.role}] ${s}`);

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;

  function snapshot(): SmokeResult["final"] {
    return {
      signalingState: pc?.signalingState ?? "(no pc)",
      iceGatheringState: pc?.iceGatheringState ?? "(no pc)",
      iceConnectionState: pc?.iceConnectionState ?? "(no pc)",
      connectionState: pc?.connectionState ?? "(no pc)",
      dataChannelReadyState: dc?.readyState ?? "(no dc)",
      selectedPair: null,
      turnInUse: false,
      iceCandidateErrors
    };
  }

  function fail(stage: string, err: unknown): SmokeResult {
    line(`FAILED at ${stage}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, failedAt: stage, log, final: snapshot() };
  }

  let ws: WebSocket;
  try {
    line(`connecting signaling WS to ${opts.signalingUrl}`);
    ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(opts.signalingUrl);
      sock.onopen = () => resolve(sock);
      sock.onerror = () => reject(new Error("signaling WebSocket error/rejected (check ALLOWED_ORIGINS / origin-forbidden)"));
    });
    line("signaling WS OPEN");
  } catch (err) {
    return fail("signaling", err);
  }

  let msgHandler: ((msg: Record<string, unknown>) => void) | null = null;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
    line(`signaling RECV: ${msg.type}`);
    msgHandler?.(msg);
  };
  function waitForType(type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for signaling "${type}"`)), timeoutMs);
      const prev = msgHandler;
      msgHandler = (msg) => {
        prev?.(msg);
        if (msg.type === type) {
          clearTimeout(timer);
          msgHandler = prev;
          resolve(msg);
        } else if (msg.type === "error") {
          clearTimeout(timer);
          msgHandler = prev;
          reject(new Error(`signaling error: ${JSON.stringify(msg)}`));
        }
      };
    });
  }
  function send(obj: Record<string, unknown>) {
    line(`signaling SEND: ${obj.type}`);
    ws.send(JSON.stringify(obj));
  }

  try {
    if (opts.role === "offerer") {
      send({ type: "create-room" });
      const created = await waitForType("room-created");
      const code = created.code as string;
      line(`room created, code=${code}`);
      (window as unknown as { __smokeReportRoomCode?: (c: string) => void }).__smokeReportRoomCode?.(code);
    } else {
      send({ type: "join-room", code: opts.roomCode });
      await waitForType("joined");
      line("joined room");
    }

    send({ type: "request-turn-credentials" });
    const turnMsg = await waitForType("turn-credentials");
    let servers = turnMsg.servers as RTCIceServer[];
    line(`got ${servers.length} ICE servers (has turn: ${servers.some((s) => JSON.stringify(s.urls).includes("turn"))})`);

    if (opts.transportFilter) {
      servers = servers
        .map((s) => {
          const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => {
            if (u.startsWith("stun:")) return false; // filtered tests are TURN-only by construction
            const isUdpTurn = u.startsWith("turn:") && !u.includes("transport=tcp");
            const isTcpOrTlsTurn = u.includes("transport=tcp") || u.startsWith("turns:");
            return opts.transportFilter === "udp-only" ? isUdpTurn : isTcpOrTlsTurn;
          });
          return { ...s, urls };
        })
        .filter((s) => s.urls.length > 0);
      line(`filtered to transportFilter=${opts.transportFilter}: ${servers.length} server entries, urls=${JSON.stringify(servers.map((s) => s.urls))}`);
    }

    pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: opts.forceRelay ? "relay" : "all" });
    pc.onsignalingstatechange = () => line(`pc.signalingState -> ${pc!.signalingState}`);
    pc.onicegatheringstatechange = () => line(`pc.iceGatheringState -> ${pc!.iceGatheringState}`);
    pc.oniceconnectionstatechange = () => line(`pc.iceConnectionState -> ${pc!.iceConnectionState}`);
    pc.onconnectionstatechange = () => line(`pc.connectionState -> ${pc!.connectionState}`);
    pc.onicecandidateerror = (ev) => {
      const e = ev as RTCPeerConnectionIceErrorEvent;
      const msg = `ICE candidate error: code=${e.errorCode} text=${e.errorText} url=${e.url}`;
      iceCandidateErrors.push(msg);
      line(msg);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        line(`local ICE candidate: type=${ev.candidate.type ?? "?"} proto=${ev.candidate.protocol ?? "?"}`);
        send({
          type: "relay-ice",
          payload: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex }
        });
      } else {
        line("local ICE gathering complete");
      }
    };

    const remoteQueue: RTCIceCandidateInit[] = [];
    let remoteDescSet = false;
    const prevHandler = msgHandler;
    msgHandler = (msg) => {
      prevHandler?.(msg);
      if (msg.type === "relay-ice") {
        const payload = msg.payload as RTCIceCandidateInit;
        if (remoteDescSet) void pc!.addIceCandidate(payload).catch((e) => line(`addIceCandidate failed: ${e}`));
        else {
          remoteQueue.push(payload);
          line("queued remote ICE candidate (no remoteDescription yet)");
        }
      }
    };

    let dcOpenResolve: () => void;
    const dcOpenPromise = new Promise<void>((resolve) => (dcOpenResolve = resolve));

    if (opts.role === "offerer") {
      dc = pc.createDataChannel("smoke-probe", { ordered: true });
      dc.onopen = () => {
        line("DataChannel OPEN");
        dcOpenResolve();
      };

      line("createOffer");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      line("setLocalDescription(offer) done");
      send({ type: "relay-sdp", payload: { type: "offer", sdp: offer.sdp } });

      const answerMsg = await waitForType("relay-sdp", opts.timeoutMs);
      const answerPayload = answerMsg.payload as { type: "answer"; sdp: string };
      await pc.setRemoteDescription({ type: "answer", sdp: answerPayload.sdp });
      remoteDescSet = true;
      line("setRemoteDescription(answer) done");
      for (const c of remoteQueue.splice(0)) await pc.addIceCandidate(c).catch((e) => line(`queued addIceCandidate failed: ${e}`));
    } else {
      pc.ondatachannel = (ev) => {
        dc = ev.channel;
        line("ondatachannel fired");
        dc.onopen = () => {
          line("DataChannel OPEN");
          dcOpenResolve();
        };
        dc.onmessage = (ev2) => {
          line(`DataChannel message: ${ev2.data}`);
          if (ev2.data === "ping") {
            dc!.send("pong");
            line("sent pong");
          }
        };
      };

      const offerMsg = await waitForType("relay-sdp", opts.timeoutMs);
      const offerPayload = offerMsg.payload as { type: "offer"; sdp: string };
      await pc.setRemoteDescription({ type: "offer", sdp: offerPayload.sdp });
      remoteDescSet = true;
      line("setRemoteDescription(offer) done");
      for (const c of remoteQueue.splice(0)) await pc.addIceCandidate(c).catch((e) => line(`queued addIceCandidate failed: ${e}`));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      line("setLocalDescription(answer) done");
      send({ type: "relay-sdp", payload: { type: "answer", sdp: answer.sdp } });
    }

    await Promise.race([
      dcOpenPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("DataChannel never reached OPEN")), opts.timeoutMs))
    ]);
  } catch (err) {
    return fail(pc ? `ice/datachannel (iceConnectionState=${pc.iceConnectionState})` : "ice/datachannel setup", err);
  }

  let pingPongOk = false;
  try {
    if (opts.role === "offerer") {
      const pongPromise = new Promise<void>((resolve) => {
        dc!.onmessage = (ev) => {
          line(`DataChannel message: ${ev.data}`);
          if (ev.data === "pong") resolve();
        };
      });
      dc!.send("ping");
      line("sent ping");
      await Promise.race([pongPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("never received pong")), opts.timeoutMs))]);
      pingPongOk = true;
    } else {
      await new Promise((r) => setTimeout(r, 2500)); // give the offerer time to receive our pong before we tear down
      pingPongOk = true;
    }
  } catch (err) {
    return fail("ping-pong", err);
  }

  let selectedPair: SmokeResult["final"]["selectedPair"] = null;
  let turnInUse = false;
  try {
    const stats = await pc.getStats();
    const types = new Map<string, string>();
    const protocols = new Map<string, string>();
    let localId: string | undefined;
    let remoteId: string | undefined;
    stats.forEach((report) => {
      const r = report as unknown as Record<string, unknown>;
      if (r.type === "candidate-pair" && (r.state === "succeeded" || r.nominated)) {
        localId = r.localCandidateId as string;
        remoteId = r.remoteCandidateId as string;
      }
      if (r.type === "local-candidate" || r.type === "remote-candidate") {
        types.set(r.id as string, (r.candidateType as string) ?? "?");
        protocols.set(r.id as string, (r.protocol as string) ?? "?");
      }
    });
    if (localId && remoteId) {
      selectedPair = {
        localType: types.get(localId) ?? null,
        remoteType: types.get(remoteId) ?? null,
        localProtocol: protocols.get(localId) ?? null,
        remoteProtocol: protocols.get(remoteId) ?? null
      };
      turnInUse = selectedPair.localType === "relay" || selectedPair.remoteType === "relay";
    }
  } catch (e) {
    line(`getStats failed: ${e}`);
  }

  const final = snapshot();
  final.selectedPair = selectedPair;
  final.turnInUse = turnInUse;
  return { ok: pingPongOk, failedAt: null, log, final };
}

function attachConsoleCapture(page: Page, label: string, lines: string[]) {
  page.on("console", (msg) => lines.push(`[${label} console] ${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => lines.push(`[${label} pageerror] ${err.message}`));
}

async function runPair(
  browser: import("@playwright/test").Browser,
  opts: {
    forceRelay: boolean;
    transportFilter: "udp-only" | "tcp-tls-only" | null;
    signalingUrl: string;
    webUrl: string;
    timeoutMs: number;
  }
) {
  const macCtx = await browser.newContext();
  const phoneCtx = await browser.newContext();
  const mac = await macCtx.newPage();
  const phone = await phoneCtx.newPage();
  const consoleLines: string[] = [];
  attachConsoleCapture(mac, "mac(offerer)", consoleLines);
  attachConsoleCapture(phone, "phone(answerer)", consoleLines);

  try {
    // Load the REAL deployed site on both sides — not localhost — so each
    // page's Origin matches ALLOWED_ORIGINS on the production signaling
    // server, exercising the actual deployed stack end-to-end.
    await mac.goto(opts.webUrl);
    await phone.goto(opts.webUrl);

    let roomCodeResolve!: (code: string) => void;
    const roomCodePromise = new Promise<string>((resolve) => (roomCodeResolve = resolve));
    await mac.exposeFunction("__smokeReportRoomCode", (code: string) => roomCodeResolve(code));

    const macResultPromise = mac.evaluate(runSmokeInBrowser, {
      signalingUrl: opts.signalingUrl,
      role: "offerer",
      roomCode: null,
      forceRelay: opts.forceRelay,
      transportFilter: opts.transportFilter,
      timeoutMs: opts.timeoutMs
    });

    const roomCode = await Promise.race([
      roomCodePromise,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("offerer never created a room (signaling stage failed)")), opts.timeoutMs))
    ]);

    const phoneResultPromise = phone.evaluate(runSmokeInBrowser, {
      signalingUrl: opts.signalingUrl,
      role: "answerer",
      roomCode,
      forceRelay: opts.forceRelay,
      transportFilter: opts.transportFilter,
      timeoutMs: opts.timeoutMs
    });

    const [macResult, phoneResult] = await Promise.all([macResultPromise, phoneResultPromise]);
    return { macResult, phoneResult, consoleLines };
  } finally {
    await macCtx.close();
    await phoneCtx.close();
  }
}

function report(label: string, result: Awaited<ReturnType<typeof runPair>>) {
  console.log(`\n=== ${label} ===`);
  console.log("--- mac (offerer) log ---");
  console.log(result.macResult.log.join("\n"));
  console.log("--- phone (answerer) log ---");
  console.log(result.phoneResult.log.join("\n"));
  console.log("--- mac final state ---", JSON.stringify(result.macResult.final, null, 2));
  console.log("--- phone final state ---", JSON.stringify(result.phoneResult.final, null, 2));
  if (result.consoleLines.length) {
    console.log("--- browser console/page errors ---");
    console.log(result.consoleLines.join("\n"));
  }
}

test.describe("minimal WebRTC connectivity smoke test (no file transfer, no IndexedDB)", () => {
  test("TEST A: direct P2P -> ping/pong (default ICE policy against the live production signaling server)", async ({ browser }) => {
    test.setTimeout(60_000);
    const result = await runPair(browser, { forceRelay: false, transportFilter: null, signalingUrl: SIGNALING_URL, webUrl: WEB_URL, timeoutMs: 25_000 });
    report("TEST A: direct P2P", result);
    const failureDetail = `mac.failedAt=${result.macResult.failedAt} phone.failedAt=${result.phoneResult.failedAt}\n${JSON.stringify(result.macResult.final)}`;
    expect(result.macResult.ok && result.phoneResult.ok, failureDetail).toBe(true);
  });

  test("TEST B: force direct failure -> TURN UDP -> ping/pong", async ({ browser }) => {
    test.setTimeout(60_000);
    const result = await runPair(browser, {
      forceRelay: true,
      transportFilter: "udp-only",
      signalingUrl: SIGNALING_URL,
      webUrl: WEB_URL,
      timeoutMs: 25_000
    });
    report("TEST B: TURN UDP only", result);
    const failureDetail = `mac.failedAt=${result.macResult.failedAt} phone.failedAt=${result.phoneResult.failedAt}\n${JSON.stringify(result.macResult.final)}`;
    expect(result.macResult.ok && result.phoneResult.ok, failureDetail).toBe(true);
    expect(result.macResult.final.turnInUse, "connected but NOT via relay — TEST B forces TURN-UDP-only, direct must be impossible").toBe(true);
  });

  test("TEST C: force UDP failure -> TURN TCP/TLS-443 fallback -> ping/pong", async ({ browser }) => {
    test.setTimeout(60_000);
    const result = await runPair(browser, {
      forceRelay: true,
      transportFilter: "tcp-tls-only",
      signalingUrl: SIGNALING_URL,
      webUrl: WEB_URL,
      timeoutMs: 25_000
    });
    report("TEST C: TURN TCP/TLS only", result);
    const failureDetail = `mac.failedAt=${result.macResult.failedAt} phone.failedAt=${result.phoneResult.failedAt}\n${JSON.stringify(result.macResult.final)}`;
    expect(result.macResult.ok && result.phoneResult.ok, failureDetail).toBe(true);
    expect(result.macResult.final.turnInUse, "connected but NOT via relay — TEST C forces TURN-TCP/TLS-only, direct must be impossible").toBe(true);
  });
});
