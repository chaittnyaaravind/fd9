import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

interface Props {
  code: string | null;
  link: string | null;
}

export function QrPairing({ code, link }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!link || !canvasRef.current) return;
    void QRCode.toCanvas(canvasRef.current, link, {
      width: 180,
      margin: 1,
      color: { dark: "#08090a", light: "#ffffff" }
    });
  }, [link]);

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be unavailable; link is still visible to copy manually */
    }
  }

  if (!code) {
    return (
      <div className="pairing-panel" aria-busy="true">
        <p>Creating a session…</p>
      </div>
    );
  }

  return (
    <div className="pairing-panel">
      <div className="qr-wrap">
        <canvas ref={canvasRef} width={180} height={180} role="img" aria-label="QR code to join this session" />
      </div>
      <div>
        <div className="eyebrow">Or enter this code</div>
        <div className="room-code" aria-label={`Room code ${code.split("").join(" ")}`}>
          {code}
        </div>
      </div>
      <button className="btn btn-secondary btn-sm" onClick={copyLink} disabled={!link}>
        {copied ? "Link copied" : "Copy invite link"}
      </button>
    </div>
  );
}
