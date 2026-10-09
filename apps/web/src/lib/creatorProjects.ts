export type ProjectStatus = "live" | "in-development";

export interface CreatorProject {
  id: "fd9" | "music97" | "my-carrier";
  index: string;
  name: string;
  tagline: string;
  description: string;
  status: ProjectStatus;
  statusLabel: string;
  href: string;
  hrefLabel: string;
}

/**
 * Every claim here is grounded in something verified directly (the live
 * site's own copy, a repo's README, or this project's own commit history) —
 * never invented. My Carrier has no live link listed on purpose: its
 * deployment has no provider credentials configured yet, so it isn't a
 * working demo for a visitor to click into.
 */
export const CREATOR_PROJECTS: CreatorProject[] = [
  {
    id: "fd9",
    index: "01",
    name: "FD9",
    tagline: "Device-to-device file transfer",
    description:
      "Two browsers negotiate a direct WebRTC connection and move bytes straight between them — no upload to a server in between, relay only when the network genuinely requires it.",
    status: "live",
    statusLabel: "Live",
    href: "https://fd9.tech",
    hrefLabel: "Visit fd9.tech"
  },
  {
    id: "music97",
    index: "02",
    name: "Music97",
    tagline: "An independent listening space",
    description:
      "“Your music. Your universe.” Original sessions and your own local music, built around the ambition to make music discovery feel like exploring a universe rather than scrolling a catalog.",
    status: "live",
    statusLabel: "Live",
    href: "https://music97.chaittnyaaravind.chatgpt.site/",
    hrefLabel: "Visit Music97"
  },
  {
    id: "my-carrier",
    index: "03",
    name: "My Carrier",
    tagline: "AI-assisted career exploration",
    description:
      "An application tracker and resume studio for a student job search — AI resume tailoring grounded strictly in real content, never invented experience, plus career research that never scrapes a platform or fabricates a listing.",
    status: "in-development",
    statusLabel: "In development",
    href: "https://github.com/chaittnyaaravind/my-carrier",
    hrefLabel: "View repository"
  }
];
