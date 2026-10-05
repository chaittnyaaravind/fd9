import { GITHUB_URL, LINKEDIN_URL, CREATOR_NAME } from "../lib/creatorLinks.js";
import type { RoutePath } from "./Nav.js";

interface Props {
  onNavigate: (path: RoutePath) => void;
}

export function Footer({ onNavigate }: Props) {
  return (
    <footer className="site-footer">
      <div className="footer-grid">
        <div className="footer-brand">
          <div className="wordmark">Fd9</div>
          <p>Peer-to-peer file transfer for everyone.</p>
          <p className="footer-credit">Built by {CREATOR_NAME}.</p>
        </div>
        <div className="footer-col">
          <div className="footer-col-title">Connect</div>
          <a className="footer-link" href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="footer-link" href={LINKEDIN_URL} target="_blank" rel="noreferrer">
            LinkedIn
          </a>
          <button className="footer-link footer-link-button" onClick={() => onNavigate("/creator")}>
            Creator
          </button>
        </div>
        <div className="footer-col">
          <div className="footer-col-title">Product</div>
          <button className="footer-link footer-link-button" onClick={() => onNavigate("/how-it-works")}>
            How it works
          </button>
          <button className="footer-link footer-link-button" onClick={() => onNavigate("/performance")}>
            Performance
          </button>
        </div>
      </div>
      <div className="footer-bottom">
        <span>Fd9 never uploads your files to a server — transfers go directly between browsers.</span>
      </div>
    </footer>
  );
}
