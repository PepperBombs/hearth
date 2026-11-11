/**
 * Matching for the quick switcher. Plain "contains" matching rather than fuzzy
 * matching, because it behaves the same for Chinese and Latin text: every word
 * typed must appear somewhere in the item's label or keywords.
 */

/** Lower-cases and folds full-width letters and digits (as typed by a Chinese input method) to plain ones. */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim();
}

/**
 * How well an item matches, from 0 (hide it) to 1 (best).
 * `haystacks` are the item's label first, then its keywords.
 */
export function matchScore(haystacks: readonly string[], query: string): number {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const texts = haystacks.map(normalize);
  let score = 1;
  for (const word of words) {
    let best = 0;
    texts.forEach((text, index) => {
      const at = text.indexOf(word);
      if (at === -1) return;
      const position = at === 0 ? 1 : /\s/.test(text[at - 1] ?? "") ? 0.85 : 0.7;
      const source = index === 0 ? 1 : 0.9;
      best = Math.max(best, position * source);
    });
    if (best === 0) return 0;
    score = Math.min(score, best);
  }
  return score;
}
