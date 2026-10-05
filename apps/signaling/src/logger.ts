/**
 * Structured, payload-free logging. Callers pass only small metadata fields
 * (room ids, peer ids, byte counts) — never SDP, ICE candidates, filenames,
 * or file bytes, which may be privacy-sensitive even though WebRTC traffic
 * itself never transits this process.
 */
type Fields = Record<string, string | number | boolean | undefined>;

function line(level: string, event: string, fields?: Fields): string {
  return JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields });
}

export const log = {
  info(event: string, fields?: Fields) {
    console.log(line("info", event, fields));
  },
  warn(event: string, fields?: Fields) {
    console.warn(line("warn", event, fields));
  },
  error(event: string, fields?: Fields) {
    console.error(line("error", event, fields));
  }
};
