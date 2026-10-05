import { randomBytes, randomInt } from "node:crypto";
import { ROOM_CODE_LENGTH, ROOM_ID_BYTES } from "@fd9/protocol";

/** Excludes visually ambiguous characters (0/O, 1/I/L). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateRoomId(): string {
  return randomBytes(ROOM_ID_BYTES).toString("base64url");
}

export function generatePeerId(): string {
  return randomBytes(9).toString("base64url");
}

export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}
