/**
 * @hearth/sdk/manifest-schema: the run-time check of a manifest.
 *
 * TypeScript already checks a manifest written with `defineApp`, but only
 * where the author's editor and build run. The framework parses every manifest
 * with this schema as well, so a bad one is caught whoever wrote it and
 * however it was built. It also checks what the types cannot say: that no
 * text is empty, that a default fits its own setting, and that both languages
 * of a string use the same {placeholders}.
 *
 * This is for the framework (the server at start-up, the `hearth-apps`
 * checks). A mini-app does not import it.
 *
 * Messages in here are English text for whoever builds or deploys an app.
 * They never reach the interface.
 */
import { z } from "zod";
import {
  APP_COLORS,
  APP_ICONS,
  APP_ID_PATTERN,
  SETTING_SCOPES,
  SPACE_KINDS,
  WIDGET_SIZES,
  type Manifest,
  type Setting,
} from "./index";

const PLACEHOLDER = /\{(\w+)\}/g;

/** The placeholder names used in a string, each once, sorted. */
function placeholdersOf(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1] ?? ""))].sort();
}

const text = z.string().refine((value) => value.trim() !== "", "Must not be empty.");

/** Both languages, neither empty, nothing else. */
const localized = z.strictObject({ en: text, zh: text });

const positiveInteger = z.number().int().positive();

/** A setting's name is the property code reads it under, so it must be a plain identifier. */
const settingName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "A setting's name must be letters, digits and underscores, starting with a letter.");

const options = z
  .record(z.string().min(1, "An option's key must not be empty."), localized)
  .refine((value) => Object.keys(value).length > 0, "Needs at least one option.");

const field = { label: localized, help: localized.optional(), scope: z.enum(SETTING_SCOPES) };

const settingSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ ...field, type: z.literal("text"), default: z.string(), maxLength: positiveInteger.optional() }),
    z.strictObject({
      ...field,
      type: z.literal("number"),
      default: z.number(),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
    }),
    z.strictObject({ ...field, type: z.literal("switch"), default: z.boolean() }),
    z.strictObject({ ...field, type: z.literal("select"), default: z.string(), options }),
    z.strictObject({ ...field, type: z.literal("multi-select"), default: z.array(z.string()), options }),
    z.strictObject({
      ...field,
      type: z.literal("list"),
      default: z.array(z.string()),
      maxItems: positiveInteger.optional(),
      maxLength: positiveInteger.optional(),
    }),
  ])
  .superRefine((setting, ctx) => {
    for (const [path, message] of defaultProblems(setting)) ctx.addIssue({ code: "custom", path, message });
  });

/** Where a setting's default does not fit the setting itself, as [path, message] pairs. */
function defaultProblems(setting: Setting): [path: (string | number)[], message: string][] {
  const problems: [(string | number)[], string][] = [];
  switch (setting.type) {
    case "text":
      if (setting.maxLength !== undefined && setting.default.length > setting.maxLength) {
        problems.push([["default"], `The default is longer than maxLength (${setting.maxLength}).`]);
      }
      break;
    case "number":
      if (setting.min !== undefined && setting.max !== undefined && setting.min > setting.max) {
        problems.push([["min"], `min (${setting.min}) is greater than max (${setting.max}).`]);
      }
      if (setting.min !== undefined && setting.default < setting.min) {
        problems.push([["default"], `The default is less than min (${setting.min}).`]);
      }
      if (setting.max !== undefined && setting.default > setting.max) {
        problems.push([["default"], `The default is greater than max (${setting.max}).`]);
      }
      break;
    case "switch":
      break;
    case "select":
      if (!Object.hasOwn(setting.options, setting.default)) {
        problems.push([["default"], `The default "${setting.default}" is not one of the options.`]);
      }
      break;
    case "multi-select":
      setting.default.forEach((key, index) => {
        if (!Object.hasOwn(setting.options, key)) {
          problems.push([["default", index], `The default "${key}" is not one of the options.`]);
        } else if (setting.default.indexOf(key) !== index) {
          problems.push([["default", index], `The default lists "${key}" twice.`]);
        }
      });
      break;
    case "list":
      if (setting.maxItems !== undefined && setting.default.length > setting.maxItems) {
        problems.push([["default"], `The default has more items than maxItems (${setting.maxItems}).`]);
      }
      setting.default.forEach((item, index) => {
        if (setting.maxLength !== undefined && item.length > setting.maxLength) {
          problems.push([["default", index], `This default item is longer than maxLength (${setting.maxLength}).`]);
        }
      });
      break;
  }
  return problems;
}

const dictionary = z.record(z.string().min(1, "A message's key must not be empty."), text);

const messagesSchema = z.strictObject({ en: dictionary, zh: dictionary }).superRefine((messages, ctx) => {
  for (const [key, english] of Object.entries(messages.en)) {
    const chinese = Object.hasOwn(messages.zh, key) ? messages.zh[key] : undefined;
    if (chinese === undefined) {
      ctx.addIssue({ code: "custom", path: ["zh", key], message: "This message exists in en but not in zh." });
      continue;
    }
    const expected = placeholdersOf(english);
    const actual = placeholdersOf(chinese);
    if (expected.join() !== actual.join()) {
      ctx.addIssue({
        code: "custom",
        path: ["zh", key],
        message: `The placeholders differ between languages: en has {${expected.join("}, {")}}, zh has {${actual.join("}, {")}}.`,
      });
    }
  }
  for (const key of Object.keys(messages.zh)) {
    if (!Object.hasOwn(messages.en, key)) {
      ctx.addIssue({ code: "custom", path: ["zh", key], message: "This message exists in zh but not in en." });
    }
  }
});

/**
 * Accepts exactly what `defineApp` describes and nothing more: an unknown
 * property is an error, so a misspelt one is not silently ignored.
 */
export const manifestSchema: z.ZodType<Manifest> = z.strictObject({
  id: z
    .string()
    .regex(
      APP_ID_PATTERN,
      "An app's ID must be 2 to 31 lower-case letters, digits and hyphens, starting with a letter.",
    ),
  name: localized,
  description: localized,
  icon: z.enum(APP_ICONS),
  color: z.enum(APP_COLORS),
  spaces: z.array(z.enum(SPACE_KINDS)).min(1, "List at least one kind of space, or leave spaces out.").optional(),
  widget: z.strictObject({ size: z.enum(WIDGET_SIZES) }),
  settings: z.record(settingName, settingSchema).optional(),
  messages: messagesSchema.optional(),
});
