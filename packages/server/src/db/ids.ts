import { randomBytes } from "node:crypto";

// 32 characters, so each random byte maps to one character with no bias.
// Lower-case letters and digits only: safe in URLs, file names and shell commands.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const LENGTH = 24; // 120 bits

/** A random, URL-safe identifier. */
export function newId(): string {
  let id = "";
  for (const byte of randomBytes(LENGTH)) id += ALPHABET[byte & 31];
  return id;
}
