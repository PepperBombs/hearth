/**
 * @hearth/sdk/manifest-schema: the run-time check of a manifest.
 *
 * TypeScript already checks a manifest written with `defineApp`, but only
 * where the author's editor and build run. The framework parses every manifest
 * with this schema as well, so a bad one is caught whoever wrote it and
 * however it was built. It also checks what the types cannot say: that no
 * text is empty, that a default fits its own setting, that both languages
 * of a string use the same {placeholders}, and that the hosts in `network`
 * are plain DNS names of the internet.
 *
 * `settingValueProblems` is the check of one setting's value, which the
 * schema applies to defaults and the server to what people save.
 *
 * This is for the framework (the server, the `hearth-apps` checks). A
 * mini-app does not import it.
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

/** Where a value does not fit: the path inside the value (empty for the value itself) and what is wrong. */
export type ValueProblem = [path: (string | number)[], message: string];

/**
 * Whether a number lies on a setting's steps, which are counted from `base`.
 * Steps such as 0.1 cannot be held exactly, so a value within a billionth of
 * a step counts as on it.
 */
function onStep(value: number, base: number, step: number): boolean {
  const steps = (value - base) / step;
  return Math.abs(steps - Math.round(steps)) <= Math.max(1e-9, Math.abs(steps) * 1e-12);
}

/**
 * Where `value` does not fit `setting`; empty when it fits.
 *
 * These are the rules for every value of a setting: the default its
 * manifest declares (checked by `manifestSchema`) and the values people save
 * (checked by the server), so that the two cannot disagree.
 *
 * - `text`: text of at most `maxLength` characters.
 * - `number`: a finite number from `min` to `max`. With `step`, it is `min`
 *   (0 when there is none) plus a whole number of steps, as in a number
 *   field of a form; `step: 1` therefore means whole numbers.
 * - `switch`: true or false.
 * - `select`: the key of one option.
 * - `multi-select`: a list of option keys, none twice.
 * - `list`: at most `maxItems` texts of at most `maxLength` characters each.
 */
export function settingValueProblems(setting: Setting, value: unknown): ValueProblem[] {
  switch (setting.type) {
    case "text":
      if (typeof value !== "string") return [[[], "Must be text."]];
      if (setting.maxLength !== undefined && value.length > setting.maxLength) {
        return [[[], `Must be at most ${setting.maxLength} characters long.`]];
      }
      return [];
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return [[[], "Must be a number."]];
      if (setting.min !== undefined && value < setting.min) return [[[], `Must be at least ${setting.min}.`]];
      if (setting.max !== undefined && value > setting.max) return [[[], `Must be at most ${setting.max}.`]];
      // A step that is not above zero is the manifest's fault, reported there, and limits nothing.
      if (setting.step !== undefined && setting.step > 0 && !onStep(value, setting.min ?? 0, setting.step)) {
        return [[[], `Must be ${setting.min ?? 0} plus a whole number of steps of ${setting.step}.`]];
      }
      return [];
    case "switch":
      return typeof value === "boolean" ? [] : [[[], "Must be true or false."]];
    case "select":
      if (typeof value !== "string") return [[[], "Must be the key of one of the options."]];
      return Object.hasOwn(setting.options, value) ? [] : [[[], `"${value}" is not one of the options.`]];
    case "multi-select": {
      if (!Array.isArray(value)) return [[[], "Must be a list of option keys."]];
      const problems: ValueProblem[] = [];
      value.forEach((key: unknown, index) => {
        if (typeof key !== "string") {
          problems.push([[index], "Must be the key of one of the options."]);
        } else if (!Object.hasOwn(setting.options, key)) {
          problems.push([[index], `"${key}" is not one of the options.`]);
        } else if (value.indexOf(key) !== index) {
          problems.push([[index], `"${key}" is listed twice.`]);
        }
      });
      return problems;
    }
    case "list": {
      if (!Array.isArray(value)) return [[[], "Must be a list of texts."]];
      const problems: ValueProblem[] = [];
      if (setting.maxItems !== undefined && value.length > setting.maxItems) {
        problems.push([[], `Must have at most ${setting.maxItems} items.`]);
      }
      value.forEach((item: unknown, index) => {
        if (typeof item !== "string") {
          problems.push([[index], "Must be text."]);
        } else if (setting.maxLength !== undefined && item.length > setting.maxLength) {
          problems.push([[index], `Must be at most ${setting.maxLength} characters long.`]);
        }
      });
      return problems;
    }
  }
}

/** Where a setting's default does not fit the setting itself. */
function defaultProblems(setting: Setting): ValueProblem[] {
  const problems: ValueProblem[] = [];
  if (setting.type === "number" && setting.min !== undefined && setting.max !== undefined && setting.min > setting.max) {
    problems.push([["min"], `min (${setting.min}) is greater than max (${setting.max}).`]);
  }
  for (const [path, message] of settingValueProblems(setting, setting.default)) {
    problems.push([["default", ...path], `The default does not fit the setting. ${message}`]);
  }
  return problems;
}

/** One label of a host name: lower-case letters, digits and hyphens, a hyphen at neither end, 1 to 63 characters. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The last label: letters only, so that an IP address such as 192.0.2.1 is not taken for a name. */
const TOP_LABEL = /^[a-z]+$/;

/** The longest host name DNS allows, in characters. */
const MAX_HOST_LENGTH = 253;

/** How many hosts a manifest may name. */
const MAX_HOSTS = 10;

/**
 * Names that lead into the network the server stands in, never out to the
 * internet: these and every name that ends in one of them.
 */
const LOCAL_NAMES = ["localhost", "local", "internal", "home.arpa"];

/** Whether `host` is a lower-case DNS name of two or more labels whose last label is letters only. */
function isHostName(host: string): boolean {
  const labels = host.split(".");
  return (
    host.length <= MAX_HOST_LENGTH &&
    labels.length >= 2 &&
    labels.every((label) => HOST_LABEL.test(label)) &&
    TOP_LABEL.test(labels.at(-1) ?? "")
  );
}

/** What is wrong with one of a manifest's hosts; null when nothing is. */
function hostProblem(host: string): string | null {
  // "localhost" has one label, so it is named for what it is rather than for its shape.
  if (host !== "localhost" && !isHostName(host)) {
    return `"${host}" is not a host name. Write a lower-case DNS name such as api.github.com: no scheme, port, path, wildcard or IP address.`;
  }
  if (LOCAL_NAMES.some((name) => host === name || host.endsWith(`.${name}`))) {
    return `"${host}" is a name of the local network. A job fetches from hosts on the internet only.`;
  }
  return null;
}

/**
 * The hosts the app's jobs may fetch from: 1 to 10 lower-case DNS names,
 * none twice and none of the local network. A job's requests are later held
 * to exactly these names, so there is nothing else to write: no scheme,
 * port, path or wildcard.
 *
 * The number is counted here rather than with `.min()` and `.max()`, which
 * would also measure a text given instead of a list and add a second,
 * misleading message to the one that says a list is wanted.
 */
const networkSchema = z.array(z.string()).superRefine((hosts, ctx) => {
  if (hosts.length === 0) ctx.addIssue({ code: "custom", message: "List at least one host, or leave network out." });
  if (hosts.length > MAX_HOSTS) ctx.addIssue({ code: "custom", message: `List at most ${MAX_HOSTS} hosts.` });
  hosts.forEach((host, index) => {
    const problem = hostProblem(host) ?? (hosts.indexOf(host) !== index ? `"${host}" is listed twice.` : null);
    if (problem) ctx.addIssue({ code: "custom", path: [index], message: problem });
  });
});

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
  network: networkSchema.optional(),
  settings: z.record(settingName, settingSchema).optional(),
  messages: messagesSchema.optional(),
});
