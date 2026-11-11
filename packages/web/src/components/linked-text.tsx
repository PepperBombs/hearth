import { Link } from "react-router";

/** A sentence with one part in brackets: what comes before, the bracketed words, what comes after. */
const LINKED = /^([^[\]]*)\[([^[\]]+)\]([^[\]]*)$/;

/**
 * An interface string that names a page of the shell, with the words that
 * name it in [brackets], drawn as a link there: "Add one on [the Apps
 * page]." The brackets mark the link in each language, wherever its words
 * fall in the sentence, and an i18n test checks that both languages mark
 * one. A string without brackets is drawn as it is.
 */
export function LinkedText({ text, to }: { text: string; to: string }) {
  const match = LINKED.exec(text);
  if (!match) return text;
  const [, before = "", label = "", after = ""] = match;
  return (
    <>
      {before}
      <Link to={to} className="font-medium text-accent hover:underline">
        {label}
      </Link>
      {after}
    </>
  );
}
