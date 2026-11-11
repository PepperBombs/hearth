/**
 * Whether the files the build imports from an app have the default export
 * it imports from them.
 *
 * The generated lists (sync.mjs) import `widget.tsx`, `page.tsx` and
 * `server.ts` by their default export (docs/mini-app-contract.md, section
 * A1). Without one, a widget or a page builds and fails only in a person's
 * browser, and a server file fails the build with an error that names the
 * generated list instead of the app. `hearth-apps sync` therefore asks for
 * the export before it writes anything, with a message that names the file.
 *
 * Like the import scan, this reads source text with the TypeScript parser
 * and runs nothing: it sees that a default export is written, not what it is.
 */
import ts from "typescript";

/**
 * The files of an app the build imports by their default export, with what
 * that export is. `widget.tsx` must be there (sync says so); the other two
 * are asked about only when the app has them.
 */
export const DEFAULT_EXPORTS = {
  "widget.tsx": "the body of the app's card on the dashboard: export default function Widget() { ... }",
  "page.tsx": "the app's page: export default function Page() { ... }",
  "server.ts": "what defineServer(manifest, collections).routes({ ... }) returns: export default app.routes({ ... })",
};

/** Whether a statement carries both `export` and `default`. */
function isExportedAsDefault(/** @type {ts.Statement} */ statement) {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
  return (
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

/**
 * Whether a module's text has a default export that survives compiling:
 * `export default ...`, `export default function` or `class`, or
 * `export { x as default }` and `export { default } from "./y"`. An
 * `export default interface` and `export type { X as default }` are erased,
 * so they do not count, and neither does `export * from`, which leaves the
 * default out.
 *
 * @param {string} file The file's name; it decides how the text is parsed.
 * @param {string} text
 * @returns {boolean}
 */
export function hasDefaultExport(file, text) {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  return source.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) return !statement.isExportEquals;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return isExportedAsDefault(statement);
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause) {
      const clause = statement.exportClause;
      if (ts.isNamespaceExport(clause)) return clause.name.text === "default";
      return clause.elements.some((element) => !element.isTypeOnly && element.name.text === "default");
    }
    return false;
  });
}
