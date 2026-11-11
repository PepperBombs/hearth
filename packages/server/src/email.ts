const isAscii = (character: string) => character.codePointAt(0)! <= 0x7f;

/**
 * One spelling per email address. Identity is keyed on the result, so every
 * place that reads an address (a sign-in token, the settings, an invitation)
 * goes through here.
 *
 * Returns null for text that is not an address Hearth accepts.
 *
 * - Upper and lower case are the same address.
 * - A letter with an accent may arrive as one character or as a letter plus
 *   a combining mark, depending on who sends it. Both are the same address:
 *   the result is in Unicode's composed form (NFC).
 * - A character outside ASCII that stands for an ASCII one is refused, for
 *   example the Kelvin sign (U+212A), which lower-cases to "k", or a
 *   full-width "ｍ". Folding it would make two different addresses one
 *   account; keeping it would store a look-alike of someone else's address.
 */
export function normaliseEmail(email: string): string | null {
  const trimmed = email.trim();
  for (const character of trimmed) {
    if (isAscii(character)) continue;
    const standsFor = character.normalize("NFKC").toLowerCase();
    if ([...standsFor].some(isAscii)) return null;
  }
  // Lower-casing can undo composition in rare cases, so compose once more.
  const normalised = trimmed.normalize("NFC").toLowerCase().normalize("NFC");
  return /^[^\s@]+@[^\s@]+$/.test(normalised) ? normalised : null;
}
