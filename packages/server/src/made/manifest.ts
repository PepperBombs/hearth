/**
 * What an app made in Hearth says of itself (docs/platform.md, "An app made
 * in Hearth"): its name and look, its collections of simple fields, and
 * what a model should know before it changes the app's data. A model writes
 * it; this file checks it, and turns its fields into the schemas the store
 * checks every row against.
 *
 * The fields are deliberately few and plain, so that a model writes them
 * right, a person can read them, and every row stays a flat object.
 */
import { APP_COLORS, APP_ICONS, WIDGET_SIZES, type Manifest } from "@hearth/sdk";
import { manifestSchema } from "@hearth/sdk/manifest-schema";
import { z } from "zod";

export const FIELD_TYPES = ["text", "number", "boolean", "date", "choice", "list"] as const;

/** A collection's or a field's name: what a model and the store both read easily. */
const NAME = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const NAME_RULE = "must start with a lower-case letter and hold only letters, digits and underscores, up to 40 in all";

const fieldSchema = z
  .strictObject({
    type: z.enum(FIELD_TYPES),
    /** A row without it is refused. Fields are optional unless they say so. */
    required: z.boolean().optional(),
    /** The values a "choice" field may take. */
    options: z.array(z.string().trim().min(1).max(60)).min(1).max(40).optional(),
  })
  .refine((field) => (field.type === "choice") === (field.options !== undefined), {
    message: 'A "choice" field lists its options, and only a "choice" field has options.',
  });

const collectionSchema = z.strictObject({
  fields: z
    .record(z.string().regex(NAME, NAME_RULE), fieldSchema)
    .refine((fields) => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 30, {
      message: "A collection has 1 to 30 fields.",
    }),
});

/**
 * A text in its maker's words, or in both languages: an app shipped with
 * Hearth speaks English and Chinese (src/made/catalog.ts), one a person's
 * model made speaks theirs.
 */
const text = (max: number) =>
  z.union([
    z.string().trim().max(max),
    z.strictObject({ en: z.string().trim().max(max), zh: z.string().trim().max(max) }),
  ]);

export const madeManifestSchema = z.strictObject({
  name: text(40).refine((name) => (typeof name === "string" ? name : name.en).length > 0, { message: "An app has a name." }),
  description: text(200).default(""),
  icon: z.enum(APP_ICONS).default("list-checks"),
  color: z.enum(APP_COLORS).default("blue"),
  /** The room its card takes on the dashboard. */
  size: z.enum(WIDGET_SIZES).default("wide"),
  collections: z
    .record(z.string().regex(NAME, NAME_RULE), collectionSchema)
    .refine((collections) => Object.keys(collections).length >= 1 && Object.keys(collections).length <= 10, {
      message: "An app has 1 to 10 collections.",
    }),
  /** What a model should know before it changes the app's data, in the maker's words. */
  instructions: z.string().trim().max(2000).default(""),
  /**
   * The hosts its page may fetch from, through the server (`hearth.fetch`),
   * as the SDK's manifests list them in `network`: shown when someone adds it.
   */
  network: z.array(z.string()).max(10).optional(),
  /**
   * Its settings, as the SDK's manifests declare them (a label in both
   * languages or one, a scope, a default): kept and shown by Hearth's own
   * settings, read by the page through `hearth.settings()`.
   */
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type MadeManifest = z.output<typeof madeManifestSchema>;

/** The page of an app made in Hearth: one HTML document, everything inline. */
export const MAX_HTML_BYTES = 300_000;
export const madeHtmlSchema = z
  .string()
  .min(1)
  .refine((html) => Buffer.byteLength(html, "utf8") <= MAX_HTML_BYTES, {
    message: `The page is larger than ${MAX_HTML_BYTES / 1000} kB.`,
  });

/** A date, or a date and time, as ISO 8601 writes them: 2026-11-17 or 2026-11-17T12:30:00Z. */
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function valueSchema(field: MadeManifest["collections"][string]["fields"][string]): z.ZodType {
  switch (field.type) {
    case "text":
      return z.string().max(5000);
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "date":
      return z.string().regex(DATE, "must be a date such as 2026-11-17, or a date and time such as 2026-11-17T12:30:00Z");
    case "choice":
      return z.enum(field.options as [string, ...string[]]);
    case "list":
      return z.array(z.string().max(100)).max(100);
  }
}

/** A text in both languages, from one in its maker's words or already in both. */
export function inBoth(value: string | { en: string; zh: string }): { en: string; zh: string } {
  return typeof value === "string" ? { en: value, zh: value } : value;
}

/** The settings as the SDK declares them: every label, help and option in both languages. */
function settingsInBoth(settings: Record<string, unknown>): Record<string, unknown> {
  const both = (value: unknown) => (typeof value === "string" ? inBoth(value) : value);
  return Object.fromEntries(
    Object.entries(settings).map(([name, setting]) => {
      if (typeof setting !== "object" || setting === null) return [name, setting];
      const { label, help, options, ...rest } = setting as Record<string, unknown>;
      return [
        name,
        {
          ...rest,
          label: both(label),
          ...(help === undefined ? {} : { help: both(help) }),
          ...(typeof options === "object" && options !== null
            ? { options: Object.fromEntries(Object.entries(options).map(([key, value]) => [key, both(value)])) }
            : {}),
        },
      ];
    }),
  );
}

/**
 * The app as the rest of the server sees any app: an SDK manifest, which
 * `manifestSchema` checks (`checkMadeManifest`), so that a made app's
 * settings and hosts follow exactly the rules of every other app's.
 */
export function asSdkManifest(appId: string, manifest: MadeManifest): Manifest {
  return {
    id: appId,
    name: inBoth(manifest.name),
    // Every app's manifest has a description; a made app may leave it to its name.
    description: (({ en, zh }) => ({ en: en || inBoth(manifest.name).en, zh: zh || inBoth(manifest.name).zh }))(inBoth(manifest.description)),
    icon: manifest.icon,
    color: manifest.color,
    widget: { size: manifest.size },
    ...(manifest.network === undefined ? {} : { network: manifest.network }),
    ...(manifest.settings === undefined ? {} : { settings: settingsInBoth(manifest.settings) as Manifest["settings"] }),
  };
}

/** Why the SDK refuses the app's settings or hosts, or null when it takes them. */
export function checkMadeManifest(manifest: MadeManifest): string | null {
  const checked = manifestSchema.safeParse(asSdkManifest("m-0000000000", manifest));
  if (checked.success) return null;
  return checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

/**
 * The store's schema for each collection: an object of exactly the fields
 * the app declared, so that a row with a field the app does not have is
 * refused with its name rather than kept unseen.
 */
export function collectionSchemas(manifest: MadeManifest): Record<string, z.ZodObject> {
  return Object.fromEntries(
    Object.entries(manifest.collections).map(([name, collection]) => [
      name,
      z.strictObject(
        Object.fromEntries(
          Object.entries(collection.fields).map(([field, spec]) => [
            field,
            spec.required ? valueSchema(spec) : valueSchema(spec).optional(),
          ]),
        ),
      ),
    ]),
  );
}
