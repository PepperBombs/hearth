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
import { APP_COLORS, APP_ICONS, WIDGET_SIZES } from "@hearth/sdk";
import { z } from "zod";

export const FIELD_TYPES = ["text", "number", "boolean", "date", "choice"] as const;

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

export const madeManifestSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).default(""),
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
  }
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
