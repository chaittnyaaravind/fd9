const UNSAFE_CHARS = /[\x00-\x1f<>:"/\\|?*\x7f]/g;

/** Strips path separators, control chars, and reserved characters before ever touching disk. */
export function sanitizeFilename(name: string): string {
  const base = name
    .replace(UNSAFE_CHARS, "_")
    .replace(/^\.+/, "") // no leading dots (hidden files / traversal-looking names)
    .trim();
  return base.length > 0 ? base.slice(0, 255) : "unnamed-file";
}

/** Appends " (1)", " (2)", ... to later files so duplicate names never collide on disk. */
export function dedupeFilenames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((rawName) => {
    const name = sanitizeFilename(rawName);
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;

    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    return `${stem} (${count})${ext}`;
  });
}
