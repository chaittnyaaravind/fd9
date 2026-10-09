import type { ReactNode } from "react";
import type { CreatorProject } from "../../lib/creatorProjects.js";

interface Props {
  project: CreatorProject;
  visual: ReactNode;
}

/**
 * The whole card IS the link (a real <a>, not a div with an onClick trap) —
 * that's what makes it keyboard-reachable and screen-reader-announced as a
 * link on its own, with no separate hidden focus target needed.
 */
export function ProjectCard({ project, visual }: Props) {
  return (
    <a className="project-card" href={project.href} target="_blank" rel="noreferrer">
      <div className="project-card-visual">{visual}</div>
      <div className="project-card-body">
        <div className="project-card-head">
          <span className="project-card-index">{project.index}</span>
          <span className={`project-card-status is-${project.status}`}>{project.statusLabel}</span>
        </div>
        <h3 className="project-card-name">{project.name}</h3>
        <p className="project-card-tagline">{project.tagline}</p>
        <p className="project-card-description">{project.description}</p>
        <span className="project-card-cta">
          {project.hrefLabel}
          <span aria-hidden="true">→</span>
        </span>
      </div>
    </a>
  );
}
