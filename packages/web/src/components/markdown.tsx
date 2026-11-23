/**
 * A model's reply, drawn from Markdown: paragraphs, lists, bold and
 * italics, code, links, tables and quotes (GitHub's flavour, through
 * react-markdown and remark-gfm).
 *
 * What a reply may do on the page is narrow, since the model writes it:
 * - No HTML of its own. HTML in the text shows as the text it is
 *   (react-markdown's default; never add rehype-raw).
 * - A link is a link only to an http(s) or mailto address, and opens in a
 *   new tab with no reference back to this page. Any other address
 *   (`javascript:`, `data:`, a path on this server) leaves its text alone.
 * - Nothing is loaded: an image is drawn as a link to it, named by its alt
 *   text, so that a reply never makes the browser fetch from any host.
 * - Its headings sit under the page's own: a reply's "#" is never a second
 *   h1.
 * - It cannot take the page down. Markdown nested deep enough (a couple of
 *   thousand ">" or "- ") overflows the stack of the parser's recursion;
 *   such a reply, or any other the parser throws on, is shown as the plain
 *   text it is, and the rest of the page stays.
 */
import { Component, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../lib/cx";
import { useI18n } from "../session/preferences";

const SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The address when a reply may link to it: absolute, and http(s) or mailto. Anything else is no link. */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return SCHEMES.has(new URL(url).protocol) ? url : undefined;
  } catch {
    // Relative, or not an address at all.
    return undefined;
  }
}

const LINK = "text-accent-fg underline decoration-1 underline-offset-2 hover:decoration-2";

/** A heading of a reply, one step under the page's, styled by its own level. */
function heading(Tag: "h3" | "h4" | "h5" | "h6", className: string): NonNullable<Components["h1"]> {
  return function Heading({ node: _node, className: own, ...props }) {
    return <Tag className={cx("mt-4 mb-1.5 font-semibold text-fg", className, own)} {...props} />;
  };
}

const COMPONENTS: Components = {
  h1: heading("h3", "text-lg"),
  h2: heading("h4", "text-md"),
  h3: heading("h5", "text-base"),
  h4: heading("h6", "text-base"),
  h5: heading("h6", "text-sm"),
  h6: heading("h6", "text-sm text-fg-2"),
  p: ({ node: _node, ...props }) => <p className="my-2" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-fg" {...props} />,
  em: ({ node: _node, ...props }) => <em className="italic" {...props} />,
  del: ({ node: _node, ...props }) => <del className="text-fg-3" {...props} />,
  ul: ({ node: _node, className, ...props }) => (
    <ul
      className={cx(
        "my-2 pl-5",
        // A task list (GitHub's "- [ ]") draws its own boxes.
        className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc",
      )}
      {...props}
    />
  ),
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal pl-5" {...props} />,
  li: ({ node: _node, className, ...props }) => (
    <li className={cx("my-0.5 pl-0.5 [&>ol]:my-0.5 [&>p]:my-1 [&>ul]:my-0.5", className)} {...props} />
  ),
  blockquote: ({ node: _node, ...props }) => <blockquote className="my-2 border-l-2 border-line pl-3 text-fg-2" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-4 border-line" {...props} />,
  code: ({ node: _node, className, ...props }) => (
    // On white with a hairline, as the look's cards are: the canvas and surface-2 are too close in light to tell apart.
    <code className={cx("rounded-kbd border border-line bg-surface px-1 font-mono text-[0.9em]", className)} {...props} />
  ),
  // A block of code scrolls sideways by itself rather than widening the reply.
  pre: ({ node: _node, ...props }) => (
    <pre
      className={cx(
        "my-2 overflow-x-auto rounded-ctl border border-line bg-surface px-3 py-2.5 font-mono text-sm leading-relaxed",
        "[&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[length:inherit]",
      )}
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th className="border border-line bg-surface-2 px-2.5 py-1 text-left font-semibold" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-line bg-surface px-2.5 py-1 align-top" {...props} />,
  a: ({ node: _node, href, children, title }) => {
    const safe = safeHref(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a href={safe} title={title} target="_blank" rel="noopener noreferrer" className={LINK}>
        {children}
      </a>
    );
  },
  // Never an <img>: drawn as a link to the picture, so that nothing is fetched until the person follows it.
  img: ({ node: _node, src, alt }) => {
    const safe = safeHref(typeof src === "string" ? src : undefined);
    const label = alt?.trim() || safe || "";
    if (!safe) return label ? <span>{label}</span> : null;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer" className={LINK}>
        {label}
      </a>
    );
  },
};

/** Addresses go through `safeHref` before the components see them too, so no other attribute keeps one it refuses. */
const urlTransform = (url: string) => safeHref(url);

/** Shows the reply as the plain text it is when the parser throws on it, in place of the whole page going blank. */
class PlainOnError extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <p className="whitespace-pre-wrap">{this.props.text}</p> : this.props.children;
  }
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const { t } = useI18n();
  // GitHub's footnotes name their list and their way back for screen readers: in the reader's language.
  const footnotes = { footnoteLabel: t("chat.footnotes"), footnoteBackLabel: t("chat.footnoteBack") };
  return (
    <div className={cx("min-w-0 [overflow-wrap:anywhere] [&>:first-child]:mt-0 [&>:last-child]:mb-0", className)}>
      <PlainOnError key={text} text={text}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} remarkRehypeOptions={footnotes} components={COMPONENTS} urlTransform={urlTransform}>
          {text}
        </ReactMarkdown>
      </PlainOnError>
    </div>
  );
}
