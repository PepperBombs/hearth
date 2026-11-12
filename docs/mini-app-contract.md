# The mini-app contract

This is the design the framework is being built to. It was agreed with the
owner before any of it was written, and it changes only by agreement. Parts
that are not built yet are marked in section B. Section C, the design of
build-order item 5, marks its own steps the same way.

## Owner's decisions (these override anything below that disagrees)

1. **Adding an app to a group asks about everyone else.** The dialog offers
   "only me for now", "everyone can view" and "everyone can edit", with "only
   me" preselected. New members get the level chosen for each app.
2. **Removing an app keeps its data.** Removal hides the app; adding it again
   brings everything back. Deleting the data is a separate action by an owner,
   with a typed confirmation.
3. **A group can have several owners.** Roles in a group are `owner` and
   `member`. Whoever creates the group is an owner and can make other members
   owners, at creation or later. A group always keeps at least one owner; this
   replaces the "one owner" index in A5. Any owner may manage members and
   access, and may move an app out of the group into their own personal space.
4. **Only the server owner creates groups and lets new people in, for now.**
   This sits behind one policy function and one server setting, so it can be
   opened to everyone later without a redesign.
5. **Edit access includes an app's shared settings.** Each person's own
   settings are always theirs to change, even with view access.
6. **Apps from other developers' repositories must be possible later.**
   `HEARTH_APPS_DIR` therefore accepts a list of folders (separated like
   `PATH`), each one a repository in the same shape as `hearth-stones` with
   its own SDK version declaration. App IDs must be unique across all folders;
   a clash fails the build and names both folders. Nothing else is built for
   this now: no marketplace, no runtime loading, no sandbox. Apps remain
   trusted code that the server owner chooses to check out.
7. **An AI assistant will later manage data across apps.** It will call each
   app's queries and mutations as tools, acting as the signed-in person with
   exactly their access. To make that possible without touching every app
   again, every query and mutation a mini-app defines carries a short
   `description` (one English sentence saying what it does, written for a
   reader who has not seen the app) next to its input schema, and a query
   never changes data. The check fails an app whose query or mutation has no
   description. Nothing else is built for the assistant now.

   Agreed for when it is built, after the grocery list: it asks the person
   to confirm every change before making it; it lives in the quick switcher
   on desktop and the Search tab on phones; the model is Claude by default,
   behind one interface so that another provider can replace it; it is off
   until a space's owner switches it on, and an owner can exclude apps.

Decisions 8 to 15, for build-order item 5, are at the top of section C.

## A. The contract

### A1. Folder layout

```
hearth/packages/sdk/            @hearth/sdk; its package.json "version" is the handshake version
  src/index.ts                  defineApp, manifest types, icon and colour unions, SDK_VERSION
  src/server.ts                 @hearth/sdk/server: types and identity functions only
  src/web/                      @hearth/sdk/web: hooks plus the UI kit (moved from packages/web/src/components/ui)
  src/testing.ts                @hearth/sdk/testing: types; implementation supplied by the framework
  eslint.js                     @hearth/sdk/eslint: the existing miniAppBoundary rule, moved here
  tsconfig.app.json
  bin/hearth-apps.mjs           sync | check | dev | test | new
hearth/packages/fixture-apps/   checklist/ and feed/: complete mini-apps used by tests and as the template

hearth-stones/
  package.json      private; "hearth": { "sdk": "^0.1.0" }; devDependencies { "@hearth/sdk": "link:../hearth/packages/sdk" }
  pnpm-lock.yaml    holds only that link
  tsconfig.json     { "extends": "@hearth/sdk/tsconfig.app.json", "compilerOptions": { "noEmit": true } }
  eslint.config.js  export { default } from "@hearth/sdk/eslint";
  grocery/
    package.json    { "name": "@hearth-stones/grocery", "version": "0.1.0", "private": true, "type": "module" }; no dependencies
    manifest.ts     required; default export defineApp(...)
    widget.tsx      required; default export: the body of the dashboard card
    page.tsx        optional; its presence sets hasPage
    server.ts       optional; default export app.routes(...)
    README.md       required
    *.test.ts       optional
```

- An app is any direct child folder holding `manifest.ts`. The folder name must equal `manifest.id` and match `^[a-z][a-z0-9-]{1,30}$`.
- File names are fixed and nothing is registered elsewhere, so deleting the folder removes the app's code.

Decisions where the designs disagreed:
- **Page and server presence come from files, not manifest flags** (Designs 1 and 3): one less thing to keep in step.
- **Two entry points for app code, `@hearth/sdk/server` and `@hearth/sdk/web`**: hooks and components in one import keeps a widget to one SDK line.
- **Strings live in `manifest.messages`** (Designs 1 and 3), not a separate file: the check can prove both languages exist and `t` is typed from it. The manifest may import them from a sibling file.

### A2. Manifest

```ts
// @hearth/sdk
export const SDK_VERSION: string;
export type Localized = { en: string; zh: string };
export type AppIcon = "bookmark" | "box" | "calendar" | /* ...the 21 names now in app-icon.tsx */ "wallet";
export type AppColor = "green" | "purple" | "teal" | "amber" | "pink" | "orange" | "blue";

type Field<T, X> = { label: Localized; help?: Localized; scope: "space" | "user"; default: T } & X;
export type Setting =
  | Field<string,   { type: "text"; maxLength?: number }>
  | Field<number,   { type: "number"; min?: number; max?: number; step?: number }>
  | Field<boolean,  { type: "switch" }>
  | Field<string,   { type: "select"; options: Record<string, Localized> }>
  | Field<string[], { type: "multi-select"; options: Record<string, Localized> }>
  | Field<string[], { type: "list"; maxItems?: number; maxLength?: number }>;

export type Manifest<S = Record<string, Setting>, M = Record<string, string>> = {
  id: string;
  name: Localized;
  description: Localized;
  icon: AppIcon;
  color: AppColor;
  spaces?: readonly ("personal" | "group")[];           // where it may be added; default both
  widget: { size: "small" | "wide" | "tall" | "large" }; // 1x1, 2x1, 1x2, 2x2 on the existing 4-column grid
  settings?: S;
  messages?: { en: M; zh: Record<keyof M, string> };     // a missing zh key is a type error
};
export function defineApp<const S extends Record<string, Setting>, const M extends Record<string, string>>(
  manifest: Manifest<S, M>): Manifest<S, M>;
export type SettingsOf<A>;   // grocery: { aisles: string[]; hideDone: boolean }; a select gives the union of its option keys
```

Decisions:
- **Settings are a record keyed by name**, not an array: keys are unique by construction and `SettingsOf` infers directly.
- **Scope is `"space" | "user"`**, matching the `users` table and `userSchema`.
- **Defaults are filled at read time**; nothing is copied into the database when an app is added, so a manifest change never needs a data migration. Localized seed defaults (Design 1) are left out because they need copy-on-add.

```ts
// grocery/manifest.ts
import { defineApp } from "@hearth/sdk";

export default defineApp({
  id: "grocery",
  name: { en: "Grocery list", zh: "购物清单" },
  description: { en: "A shared shopping list, grouped by aisle.", zh: "按货架分组的共享购物清单。" },
  icon: "shopping-bag",
  color: "green",
  widget: { size: "tall" },
  settings: {
    aisles: {
      type: "list", scope: "space", default: [], maxItems: 20,
      label: { en: "Aisles", zh: "货架" },
      help: { en: "Items are grouped in this order.", zh: "物品按此顺序分组。" },
    },
    hideDone: {
      type: "switch", scope: "user", default: false,
      label: { en: "Hide ticked items", zh: "隐藏已勾选的物品" },
    },
  },
  messages: {
    en: { empty: "Nothing to buy.", add: "Add an item", other: "Other", clear: "Clear ticked", left: "{count} left" },
    zh: { empty: "没有要买的东西。", add: "添加物品", other: "其他", clear: "清除已勾选", left: "还剩 {count} 项" },
  },
});
```

### A3. SDK for server code

```ts
// @hearth/sdk/server: types and identity functions; the implementation is in packages/server/src/apps
export { z } from "zod";                      // the one zod instance apps use
export type Row<T> = T & { id: string; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string };

export interface ReadCollection<T> {
  get(id: string): Row<T> | null;
  list(o?: { where?: Partial<T>; mine?: boolean; orderBy?: keyof T | "createdAt" | "updatedAt";
             desc?: boolean; limit?: number }): Row<T>[];          // limit defaults to 1000, at most 5000
  count(where?: Partial<T>): number;
}
export interface Collection<T> extends ReadCollection<T> {
  insert(value: T): Row<T>;
  update(id: string, patch: Partial<T>): Row<T>;   // shallow merge of top-level fields; unknown id throws not_found
  remove(id: string): void;
  removeWhere(where: Partial<T>): number;
}

type BaseCtx<M> = {
  readonly user: { id: string; name: string };
  readonly locale: "en" | "zh";
  readonly space: { kind: "personal" | "group"; name: string };   // no id: nothing in the SDK accepts one
  readonly access: "view" | "edit";
  readonly settings: SettingsOf<M>;   // the space's values, the caller's own values, defaults
  readonly now: Date;
};
export type QueryCtx<M, C>    = BaseCtx<M> & { db: { [K in keyof C]: ReadCollection<z.output<C[K]>> } };
export type MutationCtx<M, C> = BaseCtx<M> & { db: { [K in keyof C]: Collection<z.output<C[K]>> } };

export function defineServer<M extends Manifest, const C extends Record<string, z.ZodObject>>(manifest: M, collections: C): {
  query<O extends Json>(run: (ctx: QueryCtx<M, C>) => O): Query<void, O>;
  query<I extends z.ZodType, O extends Json>(input: I, run: (ctx: QueryCtx<M, C>, input: z.output<I>) => O): Query<z.input<I>, O>;
  mutation<O extends Json | void>(run: (ctx: MutationCtx<M, C>) => O): Mutation<void, O>;
  mutation<I extends z.ZodType, O extends Json | void>(input: I, run: (ctx: MutationCtx<M, C>, input: z.output<I>) => O): Mutation<z.input<I>, O>;
  routes<R extends Record<string, Query<any, any> | Mutation<any, any>>>(routes: R): AppServer<M, C, R>;
  // reserved, not designed: job, search, files, exporter, upgrades
};
export class AppError extends Error { constructor(code: "invalid_request" | "not_found" | "conflict", message: string) }
```

Decisions:
- **Design 1's builder shape** (`app.query`, `app.mutation`, `app.routes`): it is the only one of the three that types inputs and outputs end to end without `any`.
- **Named `query` and `mutation`**, with `action` kept free for a future asynchronous kind (Design 2's point).
- **Handlers are synchronous** (Designs 1 and 2): the access check and the handler run in one SQLite transaction and a request never waits on the network. A handler that returns a promise is rejected at run time; outside fetching belongs to the scheduler.
- **One JSON document table, no app-defined SQL or migrations** (all three agree): a mini-apps-only release never changes the schema and can always be rolled back.
- **No `rev`, tombstones or `upgrades` in v1** (Design 2 had them): `update` is a field-level merge inside a transaction, which is enough for a grocery list.
- **A stored row that no longer parses fails the query** with a logged app, collection and row ID. Authors therefore give every new field a `.default()`.

```ts
// grocery/server.ts
import { defineServer, z } from "@hearth/sdk/server";
import manifest from "./manifest";

const app = defineServer(manifest, {
  items: z.object({ name: z.string().trim().min(1).max(80), aisle: z.string().max(40).default(""), done: z.boolean().default(false) }),
});

export default app.routes({
  list: app.query((ctx) => ctx.db.items.list({ orderBy: "createdAt" })),
  add: app.mutation(z.object({ name: z.string(), aisle: z.string().default("") }),
    (ctx, input) => ctx.db.items.insert({ ...input, done: false })),
  tick: app.mutation(z.object({ id: z.string(), done: z.boolean() }),
    (ctx, { id, done }) => ctx.db.items.update(id, { done })),
  clearTicked: app.mutation((ctx) => ctx.db.items.removeWhere({ done: true })),
});
```

### A4. SDK for widget and page code

```ts
// @hearth/sdk/web
export function appHooks<S extends AppServer<any, any, any> | Manifest>(): {
  useApp(): {
    t(key: MessageKey<S>, ...values: PlaceholderArgs<S>): string;   // placeholders typed as in packages/web/src/i18n
    locale: "en" | "zh";
    user: { id: string; name: string };
    space: { kind: "personal" | "group"; name: string; members: { id: string; name: string }[] };
    access: "view" | "edit";
    canEdit: boolean;
    settings: SettingsOf<S>;
    pagePath: string | null;
  };
  useQuery<K extends QueryName<S>>(name: K, ...input: InputArgs<S, K>): Output<S, K>;   // suspends
  useMutation<K extends MutationName<S>>(name: K):
    { run(...input: InputArgs<S, K>): Promise<Output<S, K>>; pending: boolean; error: { code: string } | null };
};
// plus the UI kit: Button, IconButton, Input, Field, Switch, Checkbox (new), Chip, Tag, Segmented,
// Rows, Row, EmptyState, Dialog, DialogBody, Icon (new)
```

- **`useQuery` suspends** (Design 1). The shell draws the card (icon, name, space tag, "Open" link), the loading skeleton and the error state, so an app has no loading or error code.
- **Hooks are module-level identifiers** from `appHooks<typeof server>()` (Designs 2 and 3), not methods on an object, so hook lint rules recognise them.
- A successful mutation refetches that install's queries. Queries also refetch on focus and every 15 seconds while visible; that is how family members see each other's ticks.
- A `not_found` from any app route reloads the session, so a revoked or moved app disappears and nothing is written to the wrong space.
- An app never builds a URL or sees a space ID. The shell's `<AppScope>` carries space and app.
- Mini-apps may use Tailwind utility classes. The theme is already cleared down to Hearth's tokens, so token names become part of the SDK version.

```tsx
// grocery/widget.tsx
import { Checkbox, EmptyState, Row, Rows, appHooks } from "@hearth/sdk/web";
import type server from "./server";

const { useApp, useQuery, useMutation } = appHooks<typeof server>();

export default function Widget() {
  const { t, canEdit } = useApp();
  const open = useQuery("list").filter((item) => !item.done);
  const tick = useMutation("tick");
  if (open.length === 0) return <EmptyState title={t("empty")} />;
  return (
    <Rows>
      {open.slice(0, 6).map((item) => (
        <Row key={item.id}>
          <Checkbox checked={false} disabled={!canEdit} onChange={() => tick.run({ id: item.id, done: true })}>
            {item.name}
          </Checkbox>
        </Row>
      ))}
    </Rows>
  );
}
```

**Are the two first apps short?**
- **Grocery:** manifest about 25 lines, server 14, widget 20. The page adds an add form, one `Rows` per `settings.aisles` entry plus "Other", and a "Clear ticked" button: about 50 lines.
- **GitHub trending:** the manifest has two `scope: "user"` settings, `languages` (multi-select over a fixed option list) and `period` (select). The server has one `repos` collection and one query:
  ```ts
  list: app.query((ctx) => ctx.db.repos.list({ where: { period: ctx.settings.period }, orderBy: "rank" })
    .filter((repo) => ctx.settings.languages.length === 0 || ctx.settings.languages.includes(repo.language))),
  ```
  The per-person filters work in both a personal and a group space because user-scope settings are per person per install. The fetch is the reserved `app.job`, which is build-order step 5; until it exists the app has no data source.

### A5. Tables (migration 2 in `packages/server/src/db/migrations.ts`)

```sql
ALTER TABLE space_members ADD COLUMN can_add_apps INTEGER NOT NULL DEFAULT 0 CHECK (can_add_apps IN (0, 1));
CREATE UNIQUE INDEX space_members_one_owner ON space_members (space_id) WHERE role = 'owner';

-- A person the owner added to a group before they first arrived.
CREATE TABLE space_invitations (
  space_id   TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  email      TEXT NOT NULL CHECK (email = lower(email)),
  invited_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, email)
) STRICT;

-- An app added to a space: the saved setting that needs no redeploy.
CREATE TABLE space_apps (
  space_id      TEXT NOT NULL REFERENCES spaces (id),   -- no cascade: a space with app data is never deleted silently
  app_id        TEXT NOT NULL,                          -- manifest ID; no table of apps, code comes and goes with deploys
  member_access TEXT NOT NULL DEFAULT 'none' CHECK (member_access IN ('none', 'view', 'edit')),
  created_by    TEXT NOT NULL REFERENCES users (id),
  created_at    TEXT NOT NULL,
  removed_at    TEXT,                                   -- removed from the space; data kept until deleted on purpose
  PRIMARY KEY (space_id, app_id)
) STRICT;

-- The owner's exception for one member. No row means space_apps.member_access. The owner always has edit.
CREATE TABLE app_access (
  space_id TEXT NOT NULL, app_id TEXT NOT NULL, user_id TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('none', 'view', 'edit')),
  created_by TEXT NOT NULL REFERENCES users (id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space_id, app_id, user_id),
  FOREIGN KEY (space_id, app_id)  REFERENCES space_apps (space_id, app_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id) ON DELETE CASCADE
) STRICT;

-- Each person's own switch and pin. No row means switched on and not pinned.
CREATE TABLE app_prefs (
  space_id TEXT NOT NULL, app_id TEXT NOT NULL, user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  pinned  INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  PRIMARY KEY (space_id, app_id, user_id),
  FOREIGN KEY (space_id, app_id)  REFERENCES space_apps (space_id, app_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id) ON DELETE CASCADE
) STRICT;

-- Settings values: one JSON object for the space (user_id NULL) and one per person.
CREATE TABLE app_settings (
  space_id TEXT NOT NULL, app_id TEXT NOT NULL,
  user_id    TEXT,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_by TEXT NOT NULL REFERENCES users (id),
  updated_by TEXT NOT NULL REFERENCES users (id),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (space_id, app_id)  REFERENCES space_apps (space_id, app_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX app_settings_one ON app_settings (space_id, app_id, coalesce(user_id, ''));

-- Every mini-app's data.
CREATE TABLE app_rows (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL, app_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_by TEXT NOT NULL REFERENCES users (id),
  updated_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (space_id, app_id) REFERENCES space_apps (space_id, app_id) ON UPDATE CASCADE ON DELETE RESTRICT
) STRICT;
CREATE INDEX app_rows_by_scope ON app_rows (space_id, app_id, collection, created_at, id);
```

Decisions:
- **Composite key `(space_id, app_id)`**, no surrogate install ID (Designs 1 and 3 over 2): it matches the existing URLs and `AppSummary`, and the database still refuses a row for an app the space does not have.
- **`RESTRICT` on the two data tables** (from Design 2): a stray delete of a `space_apps` row cannot wipe data; only the purge function deletes rows first.
- **A per-app default for members plus per-member exceptions** (Designs 1 and 3 over 2): the owner can still set every member's level, and a family app does not need one grant per person.
- **No `apps_seen` table** (Design 2): an app whose folder is gone is shown by its ID, which is its folder name.

### A6. Enforcement rules

**Scoping**
- A mini-app never receives a database handle, a space ID or a user ID parameter.
- `packages/server/src/apps/store.ts` is the only file with SQL for `app_rows` and `app_settings`. A unit test fails if those table names appear in any other server source file.
- The store is built per request from the route-resolved install. Every statement carries `WHERE space_id = ? AND app_id = ? AND collection = ?`. `created_by` and `updated_by` come from the signed-in user.
- `where` keys are checked against the collection schema's top-level keys before becoming `json_extract` equality. Rows are parsed with the schema on write and on read.
- A row ID from another space is "not found".
- A contract test runs every store method from a second space and a second app against the fixture app and expects nothing back.

**Access**
- One function, `resolveInstall(db, userId, spaceId, appId)`, returns `null`, `"view"` or `"edit"`.
- It returns `null` for a non-member, a `removed_at` install, an app with no bundled code, or no `space_apps` row.
- The space owner (always the case in a personal space) gets `"edit"`. A member gets their `app_access` level, else `member_access`; `'none'` becomes `null`.
- `null` answers 404 `not_found` on every app route, so existence is not revealed.
- `GET /api/session` lists only non-null apps. Sidebar, dashboard, Apps page and quick switcher all derive from that list, as they already do. Future search contributions go through the same function.
- Queries need view and get a `db` with no write methods, in the type and at run time. Mutations need edit; a viewer gets 403 `forbidden`.
- The access check and the handler run in one transaction (`deferred` for queries, `immediate` for mutations), so a revoke or move cannot land between them.
- Space-scope settings need edit; user-scope settings need view.
- Only the space owner changes access, removes apps, deletes data and manages members.
- A member with `can_add_apps` may add an app and gets an `edit` exception row for it.

**Enable and pin**
- `app_prefs` rows are written only for the caller, and only where the caller has access.
- Switching an app off hides it for that person and changes no one's access. Disabled apps stay in the session with `enabled: false`, so the Apps page can switch them back on.

**Add, remove, delete data**
- Add inserts the `space_apps` row, or clears `removed_at`, which restores the old data.
- Remove sets `removed_at`.
- Deleting data is a separate owner action with the app ID typed as confirmation, allowed only when the app is removed or its code is absent. In one transaction it deletes rows, settings, then the `space_apps` row.

**Move**
- The caller must own the source space and be owner of, or hold `can_add_apps` in, the target space. `manifest.spaces` must allow the target's kind.
- A target that already has the app, even a removed one, answers 409 `conflict`. There is no merging.
- It is one `immediate` transaction:
  1. delete the app's `app_access` rows;
  2. delete `app_prefs` and user-scope `app_settings` rows of people who are not members of the target;
  3. `UPDATE space_apps SET space_id = :to, member_access = :chosen` (default `'none'`). The cascade carries rows, settings and remaining prefs; `created_by` is untouched.
- A move therefore never widens access by itself.
- A test reads `sqlite_master` and fails if any table with `space_id` and `app_id` columns lacks the cascading foreign key, so a future table cannot be forgotten.

**Folder removed**
- The app disappears from the session and all its routes answer 404. Its rows are untouched, so a mistaken deploy or a rollback loses nothing. Restoring the folder restores the app.
- The owner sees such installs in space settings by app ID with a row count and the delete-data action.
- If the web app in a browser is older than the server and lacks an app the session lists, that card shows "Reload to update".

**Groups and members**
- `POST /api/spaces` creates a group with the caller as its one owner.
- Adding a member by email: an existing user becomes a member at once. An unknown address needs the caller to be the server owner; it then gets a server invitation plus a `space_invitations` row, which `resolveMember` turns into membership on first arrival.
- Emails go through `normaliseEmail`.
- Removing a member deletes their access rows, prefs and own settings by cascade; rows they created stay.

### A7. Build, version check, "SDK only"

**Discovery.** `hearth-apps sync` reads `HEARTH_APPS_DIR` at build and dev time and writes three git-ignored files; a typed `.d.ts` beside each registry is committed, so the framework's type check never walks into app code.

```
packages/server/src/apps/registry.generated.js   export const apps = [{ id, manifest, server? }]
packages/web/src/apps/registry.generated.js      export const apps = [{ id, manifest, hasPage, widget: () => import(...), page? }]
packages/web/src/apps/sources.generated.css      @source "<apps dir>";   (Tailwind does not see files outside the Vite root)
```

- With the variable unset, the folder missing, or the folder holding no apps, all three are empty and the framework builds and tests alone.
- Only `main.ts` and `main.tsx` import the registry.
- The running server no longer reads `HEARTH_APPS_DIR`: remove `appsDir` from `Config` and the line from `deploy/hearth.env.example`.

Decision: **generated registry files** (Design 3) over virtual modules from bundler plugins (Designs 1 and 2). They work with the existing `tsx watch`, tsc and vitest unchanged.

**Configuration changes**
- `package.json`: `"build": "pnpm apps:sync && ..."`; `dev` runs sync first.
- `packages/web/vite.config.ts`: `resolve.dedupe: ["react", "react-dom"]`; `server.fs.allow` gains the apps folder.
- `packages/server/tsup.config.ts`: `noExternal: ["@hearth/shared", "@hearth/sdk"]`.
- `packages/web/src/styles/index.css`: `@source` for `packages/sdk/src` and an import of the generated CSS.
- `eslint.config.js`: `MINI_APP_ROOTS` becomes `packages/fixture-apps`; generated files are ignored.

**Version check.** `sync` compares `hearth.sdk` in the apps folder's root `package.json` (a caret range) with `packages/sdk/package.json` `version`, and checks that the `@hearth/sdk` link points at this checkout.
- A mismatch exits with status 3 and a message naming both versions.
- In the deploy that fails the build, so the old release keeps running; the next mini-apps commit is built at once.
- Policy: any breaking change to SDK types, kit component props, token class names or the manifest schema raises the minor version while below 1.0.

**"SDK only", three layers**
1. **Install.** The mini-apps lockfile holds only the link, the deploy installs it `--offline`, and `sync` fails on any `dependencies` in an app's `package.json`.
2. **Import scan in `sync`** with the TypeScript parser. It gates every build including the deploy and cannot be switched off by a comment. Allowed:
   - relative paths inside the app's own folder;
   - `@hearth/sdk` anywhere;
   - `@hearth/sdk/web` and `react` in web files;
   - `@hearth/sdk/server` only from `server.ts` and files only it imports;
   - web files import `./server` only with `import type`;
   - non-literal `import()` and `require` are errors.
3. **ESLint** via `@hearth/sdk/eslint`: the existing `hearth/mini-app-imports` rule with the same allow-list, plus `no-restricted-globals` for `fetch`, `process`, `localStorage`, `eval` and `Function`, with `noInlineConfig` on. It gives editor and pull-request feedback.

Decision: the hard gate is an **import scan** (Design 3), not bundler resolve hooks (Designs 1 and 2): one piece of code covers server and web, and also runs in `hearth-stones` CI without a bundler.

**`hearth-apps check`** runs sync, then:
- folder name equals ID, IDs unique, required files present;
- every manifest parses, with both languages non-empty for every name, description, label, help, option and message;
- defaults valid; placeholders equal across languages;
- no collection field named like a `Row` field;
- `tsc`, ESLint and vitest.

The server also validates every bundled manifest at start-up, so the deploy's trial start catches a bad one before the switch.

**Deploy script**, after the framework install:

```bash
if [[ -n $APPS_REPO && -f $new_release/hearth-stones/package.json ]]; then
  (cd -- "$new_release/hearth-stones" && clean_env pnpm install --frozen-lockfile --offline \
    --store-dir "$HEARTH_BASE/pnpm-store") >>"$build_log" 2>&1 || die "Could not link the mini-apps to the SDK."
fi
(cd -- "$new_release/hearth" && clean_env HEARTH_VERSION="$version" \
  HEARTH_APPS_DIR="$new_release/hearth-stones" pnpm build) >>"$build_log" 2>&1 || die "pnpm build failed."
```

**CI**
- `hearth`: the existing jobs; e2e builds with `HEARTH_APPS_DIR=packages/fixture-apps`. A new job checks out `hearth-stones` main beside it and builds: status 3 passes with a notice, any other failure means the SDK broke without a version bump.
- `hearth-stones`: checks out `hearth` main beside itself, installs both, runs `pnpm check` and a full framework build.
- Both use hosted runners, pinned actions and no secrets.

### A8. Routes

```
GET    /api/session                                  apps filled; AppSummary gains access, widgetSize;
                                                     Space gains canAddApps and members [{ id, name }]
POST   /api/spaces                                   create a group { name }
PATCH  /api/spaces/:spaceId                          owner: { name }
POST   /api/spaces/:spaceId/members                  owner: { email }
PATCH  /api/spaces/:spaceId/members/:userId          owner: { canAddApps }
DELETE /api/spaces/:spaceId/members/:userId          owner, or the member themselves
GET    /api/spaces/:spaceId/apps                     owner: every install incl. removed and code-absent, row counts, access table
PUT    /api/spaces/:spaceId/apps/:appId              add or restore { memberAccess? }; owner or can_add_apps
DELETE /api/spaces/:spaceId/apps/:appId              owner: remove (data kept)
DELETE /api/spaces/:spaceId/apps/:appId/data         owner: { confirm: appId }; only when removed or code absent
POST   /api/spaces/:spaceId/apps/:appId/move         { toSpaceId, memberAccess? }
PUT    /api/spaces/:spaceId/apps/:appId/access       owner: { memberAccess?, members?: { [userId]: "none" | "view" | "edit" | null } }
PATCH  /api/spaces/:spaceId/apps/:appId/me           { enabled?, pinned? }
GET    /api/spaces/:spaceId/apps/:appId/settings     { space, user }, defaults filled
PATCH  /api/spaces/:spaceId/apps/:appId/settings     { space?, user? }, checked against the manifest
POST   /api/spaces/:spaceId/apps/:appId/q/:name      query; view
POST   /api/spaces/:spaceId/apps/:appId/m/:name      mutation; edit
```

- `API_ERROR_CODES` gains `forbidden` (403) and `conflict` (409). All shapes go into `packages/shared` first.
- There is no catalogue route: the web bundle holds every manifest, and the server validates what it is asked to add.
- The page route becomes `/apps/:spaceId/:appId/*`, leaving room for several pages.
- App settings open in a shell dialog from the card and the page's top bar. The form is generated from the manifest in two groups: "For everyone in this space" (disabled without edit) and "Only for you".

### A9. Developer workflow

```
clone hearth and hearth-stones side by side
cd hearth && pnpm install
cd ../hearth-stones && pnpm install     # links @hearth/sdk; editor types work
pnpm new stocks                         # copies the checklist template (build-order step 3)
pnpm dev                                # hearth-apps dev: sync, then the framework's dev servers with
                                        # HEARTH_APPS_DIR=$PWD HEARTH_AUTH=dev; widgets hot-reload
pnpm check                              # hearth-apps check
pull request into main                  # the server builds and switches within about a minute
add the app to a space on the Apps page # a saved setting, no redeploy
```

- App tests import `testApp(server)` from `@hearth/sdk/testing`: `testApp(server).as({ access: "view" }).query("list")`. `hearth-apps test` runs vitest inside `packages/server`, where the real store and an in-memory database live.
- An SDK-breaking change: bump the SDK version in `hearth`, merge, then merge the matching `hearth-stones` change. In between, the old release keeps running.

---

## B. Build plan

Each step is one pull request; `pnpm check` passes at the end of each. A step that is built says so; the others are not built yet.

1. **SDK package skeleton.** *Built.* *Reviewed.* Add `packages/sdk` with `defineApp`, manifest types, the zod manifest schema, icon and colour unions moved from `app-icon.tsx`, and `SDK_VERSION`.
   *Testable:* type tests for message keys, placeholders and `SettingsOf`; the schema rejects a missing language, an unknown icon and a bad ID.
   *As built, where it differs from A1 and A2:*
   - The schema is `manifestSchema` in `@hearth/sdk/manifest-schema`, an entry point for the framework that mini-apps do not import. `@hearth/sdk` itself imports nothing, so a manifest does not pull zod into a widget's bundle.
   - `default` of a `multi-select` or `list` setting is typed `readonly string[]`, as `spaces` already is, so that a list declared `as const` is accepted too. `SettingsOf` still gives `string[]`.
   - The message types are `MessageKey<A>`, `PlaceholderArgs<A, K>` and `Translate<A>` (the type of `t`). They take a manifest today; `typeof server` joins in step 5.
   - The schema also checks what A7 lists under `hearth-apps check` for a single manifest: no empty text, defaults that fit their setting, the same placeholders in both languages. It refuses unknown properties, and a setting's name must be a plain identifier.
   - `step` of a `number` setting is not applied to its default: A2 does not say whether it limits values or only sets the form's increment. Step 6 decides.
2. **UI kit into the SDK.** *Built.* *Reviewed.* Move `components/ui` to `@hearth/sdk/web`, add `Checkbox` and `Icon`, add the `@source` line; the shell imports from the SDK.
   *Testable:* existing UI tests, contrast test and screenshot e2e unchanged.
   *As built, where it differs from A1, A4 and A7:*
   - `@hearth/sdk/web` exports the components A4 lists, and two helpers that already existed beside them: `buttonClass` and `chipClass`, the look of a button or chip as a class string, for links. The shell uses them, and a widget will want one for the link to its page.
   - `Card`, `CardHeader`, `CardFooter` and `Avatar` were in `components/ui` but are not in A4's list. They stay in the shell (`packages/web/src/components`), since the shell draws the card. Adding one to the SDK later breaks nothing; taking one out would.
   - `Icon` draws the names in `APP_ICONS`: `<Icon name="star" />`, with optional `size`, `color` (an app colour), `label` (for screen readers; without it the icon is decorative) and `className`. There are no interface icons such as a plus or a bin yet; a new name is added to `APP_ICONS` and to `packages/sdk/src/web/icon.tsx`, and is not a breaking change.
   - `Checkbox` takes `checked`, `onChange(checked)`, its text as children, `label` when there is no text, and what a checkbox input takes otherwise (`disabled`, `name`). Disabled dims the box and leaves the text readable.
   - `react` and `lucide-react` are dependencies of the SDK. Mini-apps still declare none.
   - The `@source` line names `packages/sdk/src/web`, not all of `packages/sdk/src`: only the kit holds class names.
   - The kit's tests moved with it and run in the SDK. The avatar's test stayed with the avatar. A new end-to-end test checks that the kit's classes reach the built stylesheet, which no unit test can see.
3. **Shared contract and migration 2.** *Built.* *Reviewed.* Extend `AppSummary`, `Space`, the error codes and the new request and response schemas; add the tables.
   *Testable:* the migration applies to a version-1 database with data; SQL-level tests for the foreign-key refusal, the cascade on a `space_id` update, `RESTRICT` on data tables and the one-owner index.
   *As built, where it differs from A5 and A8:*
   - **No one-owner index** (owner's decision 3). Three triggers on `space_members` keep the rule that replaces it: the first member of a space must be an owner, and the last owner can neither be removed nor made a plain member. They raise `SQLITE_CONSTRAINT_TRIGGER`, which the routes of step 10 turn into 409 `conflict`. Deleting a whole space is let through, because its own row is gone by then.
   - **`space_invitations` has `role` and `can_add_apps`.** Decision 3 lets the creator of a group name other owners at creation, when the rest of the family has usually not arrived on the server yet, so the invitation carries what the person becomes.
   - **Everything else in A5 is as written**: same tables, columns, keys and indexes.
   - **The session:** `AppSummary` gains `access` and `widgetSize`. `Space` gains `canAddApps` (the caller's own right: every owner, and members an owner allowed) and `members`, each `{ id, name, role }`; `role` is there because of decision 3. The session itself gains `canCreateGroups` and `canInvitePeople`, so that the interface does not decide by itself who the server's owner is (decision 4). Both are `false` until step 10 builds the policy function behind them.
   - **Adding and changing a member take a role**: `POST .../members` takes `{ email, role?, canAddApps? }` and answers `{ outcome: "added" | "invited" }`; `PATCH .../members/:userId` takes `{ role?, canAddApps? }`. `POST /api/spaces` still takes `{ name }` only: naming owners at creation is the dialog adding members straight after.
   - **`GET /api/spaces/:spaceId/apps`** answers `{ apps, members, invitations }`. An app there has `id`, `hasCode`, `removedAt`, `rowCount`, `memberAccess` and the exceptions by user ID; it has no name, because the web bundle holds the manifests. `members` adds each person's email address and `canAddApps`, which the session does not give to other members; `invitations` lists the people still to arrive. A8 has no route to withdraw an invitation; that is for step 10 to settle.
   - **Queries and mutations travel in an envelope**: the request is `{ input? }` and the answer `{ output? }`, so that a route with no input, or one that returns nothing, is still valid JSON.
   - **Settings values** are text, a number, a switch or a list of texts. The answer to the settings `PATCH` has the same shape as the `GET`.
   - **Request bodies refuse unknown properties.** A route with no response schema in `packages/shared` promises no body: the web app reloads the session instead.
   - **The names of the card sizes are listed twice**, in `@hearth/sdk` for manifests and in `@hearth/shared` for the session: the SDK imports no other Hearth package, and the API contract does not depend on the SDK. A test in the web app compares the two lists.
   - **The server fills the new fields of `Space` now**; the session still lists no apps. Nothing reads or writes the new tables yet.
   - The guard that step 11 asks for (every table with `space_id` and `app_id` follows `space_apps` on update) is already in `packages/server/src/db/apps-schema.test.ts`, so that a table added by steps 4 to 10 cannot be forgotten. The test of step 5 that keeps the names `app_rows` and `app_settings` inside `store.ts` has to leave out `db/migrations.ts` and the test files.
4. **Registry and installs on the server.** *Built.* *Reviewed.* Add `createApp({ apps })`, `resolveInstall`, add, remove, restore and delete-data routes, the session listing and start-up manifest validation. Add the fixture app `checklist` (manifest only).
   *Testable:* add to a personal space and see it in the session; removed or code-absent apps vanish and answer 404; data survives remove and restore.
   *As built, where it differs from A1, A6, A7 and A8:*
   - **`resolveInstall(db, registry, userId, spaceId, appId)`** takes the registry too, because "the server holds no code for this app" is one of its reasons for `null`. The session's list (`listAppsForUser`) is built from the same SQL, and a test compares the two for every person, space and app.
   - **A registry entry is `{ id, manifest, hasPage, server? }`.** `hasPage` is not in A7's sketch; the session's `AppSummary` needs it, and the build (step 7) knows whether `page.tsx` exists. `server` is carried and not used yet.
   - **Start-up check.** `createApp({ config, db, apps })` checks every manifest with `manifestSchema`, that each entry's `id` equals its manifest's, and that no ID comes twice. It throws `AppRegistryError`, which names every problem; `main.ts` makes the same check first, before the database is opened, prints the problems and exits with status 1, so a build with a bad app changes nothing.
   - **A running server holds no apps yet.** `main.ts` passes an empty list until step 7 writes the registry. Only tests pass apps in (`FIXTURE_APPS` in `packages/server/src/testing.ts`), so the session of a real server still lists none.
   - **Add** (`PUT`) answers 204 with no body. The caller must be in the space (else 404) and be an owner or hold `can_add_apps` (else 403, whatever the app). An app the server does not hold is 404. A `manifest.spaces` that leaves out the space's kind is 409 `conflict`. `memberAccess` is taken from whoever adds the app, a member with `can_add_apps` included.
   - **An app that is already there is left alone**: the same `PUT` again is 204 and changes nothing, so a double click is harmless. Asking for a different `memberAccess` is 409: access is changed through its own route (step 10).
   - **Bringing a removed app back is for owners, and access starts afresh.** `memberAccess` is set to what the request says (`none` when left out) and the exceptions made for single members before the removal are deleted, so that "only me for now" means that. Rows, settings and each person's switch, pin and own settings are untouched. A6 did not say what a restore does to access.
   - **A member cannot add their way into an app.** If the space has an entry they cannot see (the app is there but not for them, or it was removed), a member with `can_add_apps` gets 409 and nothing changes. Otherwise adding a removed app would hand them its old data. The answer does not say which of the two it is.
   - **Remove** answers 404 whenever `resolveInstall` is `null`, also to an owner asking about an app whose code is gone; a member who can use the app gets 403. An owner gets rid of a code-absent app by deleting its data.
   - **Delete data** answers 403 to every member who is not an owner, whether or not the space ever had the app, so it reveals nothing; 400 when `confirm` is not the app's ID; 404 when the space never had the app; 409 while the app is in the space and its code is present.
   - **`packages/server/src/apps/store.ts` exists already**, holding only `deleteAllData`, so that the SQL for `app_rows` and `app_settings` starts out in the one file A6 allows. Step 5 adds the rest there and the test that keeps it so.
   - **A request that is turned down is a thrown `Refusal`** (`packages/server/src/http/errors.ts`), answered by the application's error handler. It also rolls back the transaction it is thrown in. `readBody` (`http/body.ts`) reads and checks a JSON body against its shared schema.
   - **`packages/fixture-apps`** is a workspace package (`@hearth/fixture-apps`) so that its apps find `@hearth/sdk` and are type-checked. `checklist` has `manifest.ts` and nothing else: no `package.json`, `README.md` or `widget.tsx` of its own yet, which A1 calls required. The steps that build the check (7) and the card (8) add them.
   - **Two of A7's configuration changes came early**, because this step needs them: `MINI_APP_ROOTS` in `eslint.config.js` is `packages/fixture-apps`, and the server's bundle includes `@hearth/sdk` (`noExternal` in `tsup.config.ts`). The server still reads and ignores `HEARTH_APPS_DIR`.
   - **Two routes of A8 are in no step of this plan**: `PATCH .../apps/:appId/me` (switch and pin), which step 9's page needs, and `GET /api/spaces/:spaceId/apps` (the owners' list, with removed and code-absent apps), which the delete-data action and step 10's table need. Step 9 built the first, step 10 the second.
5. **Store and query/mutation routes.** *Built.* *Reviewed.* Add `defineServer` types, `store.ts`, transactions and error mapping; give `checklist` a server file.
   *Testable:* the two-space isolation test; view versus edit; input validation; `where` key checking; the "no SQL outside `store.ts`" test; a promise-returning handler is refused.
   *As built, where it differs from A3, A6 and A8:*
   - **A route says what it does before anything else** (owner's decision 7). `app.query` and `app.mutation` take `{ description, input? }` and then the handler: `app.query({ description: "Lists every item, oldest first." }, (ctx) => ...)`, `app.mutation({ description: "...", input: z.object({ ... }) }, (ctx, input) => ...)`. A3's `query(run)` and `query(input, run)` do not exist. The types require the description, and the server refuses at start-up an app whose route has none, so a deploy with one fails its trial start; `hearth-apps check` (step 7) can use the same function, `checkServer` in `packages/server/src/apps/definition.ts`.
   - **The server file is checked at start-up**, with the manifest: made with `defineServer` and this app's own manifest; every route made by `app.query` or `app.mutation`; names of routes, collections and fields are letters, digits and underscores, starting with a letter; no field is called `id`, `createdBy`, `updatedBy`, `createdAt` or `updatedAt` (A7 lists that last one under `hearth-apps check` only).
   - **The route answers**, in this order: 404 when `resolveInstall` gives `null`, when the app has no server file, or has no route of that name and kind (a mutation asked for under `/q/` is not there, and the other way round); 403 `forbidden` for a mutation with view access; 400 `invalid_request` for input that does not fit the route's schema, and for any input sent to a route that takes none. So a viewer learns nothing about a mutation's input.
   - **A value that does not fit its collection is the request's fault.** `insert` and `update` throw `AppError("invalid_request")`, answered with 400, so a route's input schema need not repeat the collection's rules (A3's `add` takes `name: z.string()` and leaves the length to the collection).
   - **A misuse of the store is the app's fault**, a `StoreUsageError`, logged and answered with 500: a `where` or `orderBy` on something that is not a field of the collection, a `where` value that is not text, a number, a switch or null, a limit above 5000. An undefined `where` value is refused too, so that a missing input cannot widen what is matched or deleted; `removeWhere` must be given its `where`, and `{}` deletes every row of the collection.
   - **`where` compares a value together with its kind**: `true` does not match a stored `1`, nor `"1"` a stored number.
   - **A row stored before a field was added counts as holding the field's default**, in `where` and `orderBy` as well as in what is read. A3 tells authors to give new fields a default; without this, `where: { done: false }` would silently skip the older rows.
   - **Rows that tie are in the order they were inserted.** One request writes all its rows with the same time, so `orderBy: "createdAt"` alone would leave their order open.
   - **`update` leaves a field alone when it is given as undefined; `remove` of an unknown ID is not an error.**
   - **"A stored row that no longer parses fails the query" holds for rows the query reads.** `count`, `remove` and `removeWhere` do not parse rows, and a `list` whose `where` leaves the row out still answers. The log entry is an `AppFaultError` naming the app and the route, whose cause names the collection and the row and nothing of the row's content.
   - **The store closes when the handler returns.** Every method of `ctx.db` then throws. A handler that returns a promise is refused as A3 says (500, the mutation's writes undone); closing the store also stops what an `async` handler does after its first `await`, which would otherwise run outside the transaction and after the access check.
   - **Errors of a handler:** `AppError` becomes 400, 404 or 409 with its message and is not logged; anything else, including an answer that cannot be sent as JSON, is logged as `AppFaultError` and answered with 500 `internal`. In every case nothing the mutation wrote is kept.
   - **A query must return JSON; a mutation may return nothing**, which is answered with `{}`. The type `Json` is exported from `@hearth/sdk/server`.
   - **`ctx` is frozen**, and `ctx.space.name` is empty for a personal space, as it is in the database.
   - **`ctx.settings` holds the manifest's defaults.** Nothing can be saved yet; step 6 replaces the body of `settingsFor` in `packages/server/src/apps/settings.ts`, the one place the handlers' settings come from.
   - **`@hearth/sdk/server` imports zod** (it exports `z`); `@hearth/sdk` still imports nothing. A web file reaches the server file with `import type` only (step 7's scan), so zod stays out of a widget's bundle.
   - **`typeof server` stands for the app** in `SettingsOf`, `MessageKey` and `Translate`, as step 1 left open. `InputOf` and `OutputOf` give a route's types for step 8's hooks.
   - **The "no SQL outside `store.ts`" test** (`store-boundary.test.ts`) leaves out `db/migrations.ts` and test files, as step 3 said it must, and also fails when a statement in `store.ts` does not name its space and app.
   - **`@hearth/sdk/testing` and `testApp(server)` are not built** (step 13). The framework's own tests call the routes over HTTP. Step 13 built them.
6. **Settings.** *Built.* *Reviewed.* Build the schema from the manifest, the two settings routes and `ctx.settings`.
   *Testable:* defaults filled, unknown keys dropped, space keys need edit, user keys are per person.
   *As built, where it differs from A2, A6 and A8:*
   - **"The schema from the manifest" is one function, not a zod schema**: `settingValueProblems(setting, value)` in `@hearth/sdk/manifest-schema` says where a value does not fit a setting. `manifestSchema` applies it to every default and the server to every value saved, so the two cannot disagree. The web form of step 9 can use it too.
   - **`step` limits values** (step 1 left this open): a number is `min`, or 0 when there is none, plus a whole number of steps, as in a form's number field, so `step: 1` means whole numbers. A value within a billionth of a step counts as on it, because steps such as 0.1 cannot be held exactly. A default that is off its own steps now fails the manifest check. The SDK's version stays 0.1.0: no mini-apps repository declares one yet.
   - **A2's limits and no others.** A text without `maxLength` and a list without `maxItems` are bounded only by the 64 KB limit on a request. A list may hold empty texts and the same text twice; a multi-select may not hold a key twice.
   - **`GET` needs view and answers both groups**, also to a viewer: `space` holds every space-scope setting and `user` every user-scope one, each exactly once. An app without settings answers two empty groups.
   - **`PATCH` answers**, in this order: 404 when `resolveInstall` gives `null`; 403 `forbidden` when it names a setting under `space` and the caller may only view, whatever the names and values are; 400 `invalid_request` for a name the manifest does not declare under that scope and for a value that does not fit. A request is saved as a whole or not at all, in one immediate transaction with the access check. `{}`, and `space: {}` from a viewer, change nothing and answer with the settings.
   - **"Unknown keys dropped" is about what is read.** A value stored under a name the manifest no longer declares, or under the other scope, is not read, in the routes and in `ctx.settings` alike. A *request* that names an unknown setting is refused with 400, like every other request with a property the server does not know.
   - **A stored value that no longer fits reads as the default**, each value judged by itself, and nothing is logged. A multi-select first loses the keys that are no longer options and keeps the rest. A2 said only that defaults are filled at read time; without this, a handler could be given a select value outside the union its types promise.
   - **Nothing that is not read is deleted.** Saving replaces the values the request names and leaves the rest of the stored object alone, so a release that is rolled back, or a setting that returns, finds its values again.
   - **Only saved values are stored.** A value equal to the default is stored like any other and stays when the default later changes. There is no way to put a setting back to "not saved"; the form of step 9 should therefore send only what the person changed.
   - **`ctx.settings` is read inside the call's transaction**, after the access check: `settingsFor(db, { spaceId, appId, userId }, manifest)` in `packages/server/src/apps/settings.ts`. Its lists are copies, so a handler that changes one changes nothing else.
   - **The SQL is in `store.ts`** (`readSettingsData`, `writeSettingsData`), as A6 requires. One read fetches the space's object and the caller's own and nobody else's.
   - The sample app `checklist` already declared a setting of each scope; its server file does not read them yet.
7. **Build pipeline.** *Built.* *Reviewed.* Add `hearth-apps sync` and `check`, the generated registries, the Vite and tsup changes, the version check, the import scan and `@hearth/sdk/eslint`. Add the second fixture `feed` (widget only, user-scope settings).
   *Testable:* build with no apps folder, an empty one and the fixtures; each violation fails with a clear message (wrong version exits 3, foreign import, value import of `./server`, dependency declared, ID not equal to folder).
   *As built, where it differs from A1, A7 and A9:*
   - **The command is plain JavaScript**, so that it runs before anything is built: `bin/hearth-apps.mjs` reads the command line and `packages/sdk/tools` does the work (`sync.mjs`, `import-scan.mjs`, `check.mjs`, `eslint-boundary.mjs`). The type check covers it through its JSDoc comments. `dev`, `test` and `new` end with status 2 and say that they are not built (step 13 built `dev` and `test`, step 14 `new`).
   - **Which folders.** `sync` reads `HEARTH_APPS_DIR` and nothing else: one folder or several separated like `PATH` (owner's decision 6). A relative folder is read from the root of the `hearth` checkout, wherever the command runs. `check` reads the same variable, and checks the folder it runs in when the variable is not set, which is how a mini-apps repository checks itself. `packages/web/vite.config.ts` reads the variable the same way for the dev server's `fs.allow`.
   - **A folder without apps is asked nothing**: no `package.json`, no link. `hearth-stones` as it stands today builds.
   - **The handshake.** `hearth.sdk` must be a caret range of three numbers (`^0.1.0`), read as npm reads one. Status 3 means a version that does not fit and nothing else: a folder of apps with no declaration, a declaration that is not a caret range, a missing `node_modules/@hearth/sdk` or one that leads to another checkout all end with status 1. Apps written for another version are not looked at further; when some other folder has a problem of its own, the status is 1.
   - **`sync` runs none of an app's code.** It checks what a folder shows: the folder's name fits the pattern for IDs, no ID is in two folders (the message names both), `widget.tsx` is there (the web app's list cannot be written without it), `widget.tsx`, `page.tsx` and `server.ts` have a default export where they exist (read with the TypeScript parser, `tools/default-export.mjs`: the generated lists import that export, and without it a widget fails only in a browser and a server file fails the build with an error that names the generated list), no `package.json` of an app declares dependencies of any kind, and the import scan. **"ID not equal to folder"** needs the manifest to be run, so `check` finds it, and the server finds it at start-up; a plain build does not.
   - **Nothing is written when anything is refused**, and a file that already says the same is left alone, so that a watching dev server does not restart.
   - **The generated lists** import the apps by relative path. The server's entries carry `hasPage` (step 4). The style sheet gets one `@source` line for each app's folder, not one for the whole apps folder. The committed types are `registry.generated.d.ts` beside each list.
   - **The import scan decides a file's side by who imports it.** `widget.tsx` and `page.tsx` start the browser's side, `server.ts` the server's, and `manifest.ts` is on both. Only imports that survive compiling count: `import type`, `export type ... from` and `typeof import()` put a file on no side, while `import { type X }` does, because the import itself stays. A file both sides import may use neither `@hearth/sdk/web` nor `@hearth/sdk/server`; a file nothing imports may use either, not both.
   - **What the scan allows beyond A7's list:** test files (`*.test.ts`) may import `vitest` and `@hearth/sdk/testing`, which A9 expects and A7 forgot. **What it refuses beyond the list:** `import type` from `@hearth/sdk/server` in a widget (A7 names no exception; allowing it later breaks nothing), every `require`, a link inside an app's folder that leads out of it, and an import of one of the app's own files that the scan does not read (hidden, or in a `node_modules` folder). An address is read without what a bundler lets follow it, so `./server?raw` in a widget is the server file.
   - **ESLint asks the same scan.** `hearth/mini-app-imports` calls `scanApp` for the file's app, with the text the editor holds, so the two layers cannot disagree. `@hearth/sdk/eslint` is a whole configuration for a mini-apps repository (the recommended rules of ESLint and typescript-eslint, then the boundary) and also exports `miniAppBoundary`; this repository's own `eslint.config.js` imports `tools/eslint-boundary.mjs` by path, to keep working when typescript-eslint cannot be loaded.
   - **The SDK carries what a mini-apps repository needs**, so that such a repository installs nothing but the link: `typescript`, `eslint`, `@eslint/js`, `typescript-eslint` and `@types/react` are dependencies of `@hearth/sdk` now. `tsconfig.app.json` (A1) is there, because `check` runs the compiler with the folder's own `tsconfig.json`; its `paths` lead `react` to the SDK's copy of React's types, since an apps repository has no React of its own.
   - **`check`** runs sync, then four stages, all of them even when one fails: `README.md` and `package.json` in every app; manifests and server files, by running `createRegistry` on the generated list (`packages/server/src/apps/check-bundle.ts`, started with `tsx`), which is the server's own start-up check; the compiler; ESLint on the app folders. **It does not run tests**: `hearth-apps test` and `@hearth/sdk/testing` are step 13. When an app has test files, it says that they were not run. Step 13 made the tests its fifth stage. Because it runs sync, it also writes the three generated files, for the folder it checked.
   - **`--out <folder>`** sends the generated files somewhere else. The tests use it so that they never change what this checkout builds.
   - **The server's configuration** has no `appsDir`. A JSON config file may still name `HEARTH_APPS_DIR`: it is ignored, so that a file written for an earlier release does not fail the trial start.
   - **The web app holds the list and draws nothing from it.** `main.tsx` gives it to `BundledAppsProvider` (`packages/web/src/apps/bundled.tsx`); step 8 reads it. Each widget is a file of its own in the build, fetched when first asked for.
   - **The fixtures.** `packages/fixture-apps` declares `hearth.sdk`, and its `tsconfig.json` extends the SDK's. `checklist` gained `package.json`, `README.md` and `widget.tsx`; `feed` has a manifest with two settings of each person's own, a widget and no server file. Both widgets are placeholders that draw the app's icon: a widget has no way to get strings, settings or data until step 8.
   - **The end-to-end tests build with the fixtures** (A7 lists that under CI): `playwright.config.ts` runs `pnpm apps:sync` with `HEARTH_APPS_DIR=packages/fixture-apps` before each build, so the workflow file did not change. After `pnpm e2e` both `dist` folders hold the sample apps until the next `pnpm build`.
   - **The deploy script is unchanged** (step 12). It does not pass `HEARTH_APPS_DIR`, so a deployed release still holds no mini-apps. The line is gone from `deploy/hearth.env.example`.
   - **Proven here, as section E asked:** an apps folder outside the checkout, linked to the SDK, passes `check` (a unit test) and builds (`link:`-style symlink, `dedupe`, `@source`, `noExternal`; tried by hand with `pnpm build`, the built server and `pnpm dev`, and the same mechanics are under test with `packages/fixture-apps`, which has no React of its own either). The build fails without `resolve.dedupe`. `pnpm install` in such a folder and the deploy's `--offline` install were not tried: `hearth-stones` has no `package.json` until step 13.
8. **Widgets and pages in the shell.** *Built.* *Reviewed.* Add `AppScope`, `appHooks`, lazy widgets on the dashboard with skeleton and error states, the app page route, polling, session reload on `not_found` and the "Reload to update" card.
   *Testable:* e2e with fixtures: tick an item in the widget, see it on the page; the Content-Security-Policy still holds.
   *As built, where it differs from A1, A4 and A8:*
   - **The hooks hold no logic.** `appHooks<S>()` in `@hearth/sdk/web` returns the same three functions for every app; only the types differ. They read one React context, which the shell fills. That context is a third entry point, `@hearth/sdk/web/scope`, for the framework only: the import scan refuses it in a mini-app, as it refuses every name not on its list. The SDK still fetches nothing; a test can put a stand-in around a widget.
   - **`S` is `typeof server`, or `typeof manifest` for an app without a server file.** Then `useQuery` and `useMutation` accept no name at all. The types are `QueryName`, `MutationName`, `InputArgs`, `Output`, `AppContext`, `MutationResult` and `AppHooks`. A route whose input schema accepts `undefined` may be called without one.
   - **`<AppScope>`** (`packages/web/src/apps/scope.tsx`) makes the calls with TanStack Query, which the shell already used for the session. Everything cached for one app in one space shares a key prefix, so after a successful mutation every query of that app in that space, and its settings, is read again. **`run` resolves only once that re-read is done**, so the screen already shows the change when the promise settles. A mutation the server turned down is followed by the same re-read before `run` rejects, because the refusal is often about something another person changed first (an item already cleared); only a mutation that got no answer is not. It rejects on failure, but the shell reports it, so a caller that does not wait need not catch it.
   - **Settings come from the settings route** (`GET .../settings`), the space's and the reader's own merged into one object by name. `useApp` suspends until they are known; an app that declares none asks nothing. They are polled with the queries, so a changed shared setting reaches everyone.
   - **Polling** is TanStack Query's: every 15 seconds while the document is visible, nothing while it is hidden, at once when it is shown or focused again. A query that cannot reach the server is tried twice more; one the server refused or failed is not. A later reading that fails keeps showing what was there.
   - **`not_found` from any of an app's calls** (query, mutation or settings) loads the session again, and the card or page goes with the app. The failed call is not repeated against another space.
   - **What the shell draws, in `<AppView>`** (`packages/web/src/apps/app-view.tsx`): a skeleton while the app's code and its first answers are on their way (the code is fetched beside the settings, not after them); "This app could not be loaded" with "Try again", which starts the app's queries afresh; a notice under the widget when a change could not be saved, with its own words for `forbidden`, and for `invalid_request`, `not_found` and `conflict`, which say that the change was not made and offer no retry; "Reload to update" when this build lacks the app or its page, or when the app's code can no longer be fetched (a newer build replaced the files). Each card is its own error boundary, so a fault in one app's code stays in its card.
   - **The card's frame** shows the space's name as a tag only for a group, and "Open" only for an app with a page. For a screen reader the card is a region named after the app and, in a group, the group ("Checklist in Family"), and the link says the same ("Open Checklist in Family"), so that the same app in two spaces gives two names. `pagePath` is the shell's own address for the page; it does hold the space's ID, as an opaque string the app does not build. An app links to it with a plain `<a href={pagePath}>`, and the shell follows such a click without reloading Hearth.
   - **`t`** gives the English string when the reader's language lacks one, and the key itself for a key the manifest does not have, so that a mistake shows and does not break the card. The manifest check already makes both impossible for a checked app.
   - **The page route** is `/apps/:spaceId/:appId/*`. An app the session does not list, one switched off, or one without `page.tsx` has no page ("Page not found"). The shell draws the top bar with the app's name and, in a group, the group's name as a tag after it, on phones too.
   - **The fixtures are real apps now.** `checklist` gained `page.tsx` (the list by section, a form to add an item, "Clear ticked") and a `submit` string; its widget lists the open items with a box to tick. `feed`'s widget reads the reader's own settings, typed from the manifest; its strings changed to say how many topics are followed.
   - **`Checkbox` changed without a change to its props**: the box lies above its invisible touch margin, so a press lands on the box itself (end-to-end tests could not click it before). Its text, and a `Row`'s, wraps a long word or a pasted link inside the card (`overflow-wrap: anywhere`). The SDK's version stays 0.1.0.
   - **Tests.** The hooks' types and their run-time hand-over are in `packages/sdk/src/web/hooks.test.tsx`; the shell's side, with the fixture apps and a stand-in server, in `packages/web/src/apps/app-view.test.tsx`. End to end, `e2e/widgets.spec.ts` covers skeleton, sizes, ticking in the widget and seeing it on the page, adding on the page, view access, Chinese, polling and visibility, failure, `not_found` and "Reload to update" against the stand-in; `e2e/real-server.spec.ts` adds the sample apps on the real server, ticks an item in the widget, sees it ticked on the page and after a reload, and fails on any script error or anything the Content-Security-Policy refused.
9. **Per-person controls and the settings form.** *Built.* *Reviewed.* Add the Apps page with add, switch and pin, plus the generated settings dialog. New strings go in `en.ts` and `zh.ts`.
   *Testable:* e2e: add an app to the personal space without a rebuild, pin it, switch it off, change a setting in both languages.
   *As built, where it differs from A6 and A8:*
   - **`PATCH .../apps/:appId/me` is built here** (`setAppPrefs` in `packages/server/src/apps/installs.ts`), since step 4 found it in no step. It writes the caller's own `app_prefs` row and nobody else's, in one immediate transaction with `resolveInstall`: 404 when that is `null`, view access enough, 400 for a body that is not `{ enabled?, pinned? }`. It answers 204 with no body, and `{}` writes nothing. What the request leaves out stays as it is; a new row starts from "on, not pinned".
   - **What a pin does.** A6 says only that it exists. Pinned apps come first, each part in the session's order, wherever apps are listed (`enabledApps` and `pinnedFirst` in `packages/web/src/session/session.ts`): the dashboard, the sidebar, the quick switcher and each space's list on the Apps page. "Pinned" at the top of the Apps page holds shortcuts to them, across spaces. Any other dashboard ordering is still left out.
   - **The Apps page** lists every app the session lists, by space, the switched-off ones too (dimmed, with a note), so that they can be switched on again. A row has the pin, the switch, the settings and, for an owner of the space, "Remove" (the route of step 4), which asks first and says that the data is kept. Deleting data is not offered: it needs the owners' list of removed and code-absent apps (`GET /api/spaces/:spaceId/apps`), which is not built.
   - **The way to the Apps page** (from the review): the sidebar has "Apps" under "Dashboard", as the phone's tab bar has, and an app's own page is marked by the app's own entry, not by "Apps". The empty dashboard offers "Go to the Apps page", and the texts of a group's card that send someone to the Apps page (step 10) link to it: words in [brackets] in an interface string are drawn as a link by `LinkedText` (`packages/web/src/components/linked-text.tsx`), and a test checks that both languages mark the same link. Under a space whose switched-on apps all lack a page, the sidebar says "Widgets only, on the dashboard", not "No apps yet".
   - **"Add an app"** shows where the session says `canAddApps`, and offers the apps this build holds that the space does not list for this person and whose manifest allows the space's kind. In a group it asks who else may use the app, "only me for now" chosen first (owner's decision 1). When there is nothing to offer, the card says why: the build holds no apps (a plain `pnpm build`, and every deployed release until step 12), every app it holds is here already, or the others are not for this kind of space.
   - **A removed app comes back with its data** when an owner adds it (step 4's restore), and the dialog says so (from the review; this step first offered it like a new app, since no route listed removed apps until step 10). For an owner the dialog reads the owners' list of step 10, which the page asks for, and adds nothing until it has it ("Try again" if it could not be read): an app the space removed says "Removed earlier" and what comes back, its data with the number of saved entries or, with none, its settings, and the button says "Bring back". Who else may use it is asked as for a new app, "only me for now" first. A member who may add apps reads no owners' list; the server turns such an app down for them (step 4).
   - **After adding or removing, refused or not**, the session and the space's owners' list are loaded again, as after a move: a refusal usually means that the page was out of date, because someone else added or removed the app first. The dialog then says, for a refused add, to an owner that the app may have been added meanwhile, to anyone else that it cannot be added here and to ask an owner, and for a 404 that the server no longer holds the app; for a refused remove, that the app is no longer in the space (it has usually left the page, with the dialog, by then) or, for a 403, that removing is for owners. A dialog that closes after a change does so with `mutateAsync`, or because the page no longer shows what it was about, so that it does not open again by itself.
   - **The settings dialog** opens from the Apps page, from a button on the app's card and from the top bar of its page (`Page` gained `actions`). The space's group is "For everyone in this space" in a group and "For this space" in a personal one; for someone who may only view, it is shown read-only with a note. The controls: text box, number box (its limits in words under it), switch, a row of choices for a select, chips for a multi-select (kept in the options' order), and a list whose entries can be edited, moved, removed and added at the end (an empty new entry is not added; a full list says so).
   - **Only changed values are sent**, as step 6 asked, measured against what was saved when the dialog opened, so a value someone else saved meanwhile is not sent back unchanged. Before sending, every value is checked with `settingValueProblems`; only a number's box can hold one that does not fit, since the other controls offer only what fits. After saving, the dialog closes, the cached settings become the server's answer and the app's queries are read again, since a route may read its settings. A refusal keeps the dialog open with a message. The dialog shares the cached settings with `<AppScope>` (`settingsQuery` in `packages/web/src/apps/scope.tsx`).
   - **A change to step 8:** after a mutation's `not_found`, the session is loaded first and an app it no longer lists is not read again; a session reload already on its way is reused, not started again. Before, the reads that followed the refusal also found the app gone and each reloaded the session once more, which made the end-to-end test of a removed app fail now and then (three or four session requests where it expects two). An app that is still listed (the `not_found` was about a row) is read again as before.
   - **One change in the SDK, not to its props** (from the review): `Dialog` closes on a click outside only when the press was outside too. Selecting text in a field and letting go over the backdrop gives a click on the `<dialog>` itself, which used to close it and lose what was typed in the settings dialog and the dialog that adds a person (step 10). The dialog and the page are the shell's; the SDK's version stays 0.1.0. `CardHeader`'s `aside` may hold a small button.
   - **Tests.** `packages/server/src/apps/prefs.test.ts` (the route); `packages/web/src/apps/manage.test.tsx` (the Apps page and the dialog, every setting type, in both languages, with a stand-in server; since the review also bringing an app back, the reasons there is nothing to add, refused adds and removes, and the empty dashboard's link); `packages/web/src/components/shell/sidebar.test.tsx`; `e2e/apps.spec.ts` against the stand-in (add to a group with the access question, bringing an app back, pin, switch off, remove, settings in English then Chinese, a viewer, phone sizes, measured with `expectNothingPastTheEdge` in `e2e/fixtures.ts`); `e2e/shell.spec.ts` (the way to the Apps page on a desktop); and in `e2e/real-server.spec.ts` the Testable line itself against the built server: the checklist, removed from the personal space by the test before with its data kept, is brought back on the Apps page while the server runs, pinned (kept after a reload), given a setting of the space and one of the person's own in English and again in Chinese, then switched off and gone from the dashboard.
10. **Groups, members and access.** *Built.* *Reviewed.* Add create group, add and remove members, `space_invitations` in `resolveMember`, `can_add_apps`, the access route and a "Family" card in Settings with the member-by-app table.
    *Testable:* a member with no access gets 404 and the app is absent from their session; view cannot mutate; a new member gets the per-app default; a `can_add_apps` member can add.
    *As built, where it differs from A5, A6 and A8:*
    - **One policy function and one setting** (owner's decision 4). `groupRights(config, user)` in `packages/server/src/groups/policy.ts` answers `canCreateGroups` and `canInvitePeople`; the session reports it, and the routes that create a group or invite an address ask it again. It reads `HEARTH_GROUP_POLICY`: `owner`, the default, is the server's owner alone; `everyone` opens both to every person on the server. Adding someone who is already on the server needs neither: that is for the group's owners.
    - **Routes built here:** `POST /api/spaces` (201, with the space as the session lists it), `PATCH /api/spaces/:spaceId` (rename; 204), `POST`, `PATCH` and `DELETE` on members, the access route, and the owners' list `GET /api/spaces/:spaceId/apps`, which step 4 found in no step and the table needs. Renaming is in A8 and in no step; it came here with the card. Moving an app is step 11.
    - **Taking an invitation back** (step 3 left it to this step): `DELETE /api/spaces/:spaceId/invitations` with `{ email }` in the body (`withdrawInvitationRequestSchema`), owners only, 404 for an address the group has not invited. The address travels in the body, not in the address of the request, which proxies log. When it was the address's last invitation to a group, its invitation to the server goes too: inviting to a group is the only way in the interface offers, and a mistyped address should not stay let in.
    - **An invitation is two rows**, as A6 says: the server's `invitations` row, which lets the person in, and a `space_invitations` row with the role and right to add apps. `resolveMember` turns the second into membership in the transaction that creates the user (`joinInvitedSpaces` in `packages/server/src/db/people.ts`), for every group that invited them. A `space_invitations` row alone lets nobody in.
    - **Every owner manages the group** (A6 says "only the space owner"; decision 3 allows several): any owner may rename it, add people, change their role or right to add apps, remove them (other owners included), take invitations back, read the owners' list and change access. Anyone may leave. The answers, in this order: 404 for someone not in the space, 403 for a plain member, 409 for a personal space (nobody joins, leaves or renames it); then 400 for an address Hearth does not accept, 403 for an address that is not on the server when `groupRights` does not allow inviting, 409 for someone already in the group or already invited, and 409 when a change would leave the group without an owner (the triggers' `SQLITE_CONSTRAINT_TRIGGER`, turned into a Refusal by `keepingAnOwner` in `packages/server/src/groups/members.ts`).
    - **Exceptions survive a change of role** (A6 does not say). An owner can use every app whatever an exception says; the exceptions made for someone as a member stay when they become an owner and apply again if they stop being one, so stepping someone down never gives them more than they had. The access route accepts an exception for anyone in the space, an owner included (400 for anyone else).
    - **The access route** answers 404 whenever `resolveInstall` gives `null` for the person asking, also to an owner for a removed app or one whose code is gone (access starts afresh when such an app comes back), then 403 for a member who can use the app. A request is saved as a whole or not at all, and `{}` changes nothing.
    - **The owners' list** answers 403 to a member and 404 to anyone else, and works for a personal space too. It reports what was decided and decides nothing: `resolveInstall` stays the one answer to what a person may do, and a test reads each member's access off the list the way the web app does and compares it with their session.
    - **Removing a member** deletes their exceptions, switches, pins and own settings by the cascade of A5; the rows they wrote stay with the group.
    - **The "Family" card is a card per group**, named after it, in Settings (`packages/web/src/groups`). Everyone in a group sees its people by name and role and can leave it, after a question. Its owners also see each person's address and right to add apps, rename the group (saved when the field is left, as a person's own name is), add a person (address, role, may add apps; the dialog says whether someone new would be invited, from `canInvitePeople`), manage each person in a dialog (role and right to add apps saved at once, remove after a question), take an invitation back, and choose access in the member-by-app table: one row per app the group has, a column "Everyone" (what every member gets, people who join later included) and one per member who is not an owner, where "As everyone: …" is no exception. A choice is saved at once and shown before the server answers. On a phone the table scrolls sideways inside its card. A "Groups" card explains groups and, where the session says `canCreateGroups`, creates one; someone in no group who may not create one is told how they get into one. "The Apps page" in the card's texts is a link to it (step 9).
    - **A person's dialog closes for good** when they leave the group or the owner viewing it stops being one, whoever made the change (from the review). Before, removing someone left them chosen, because the reloaded session took the dialog away before the removal settled, and their dialog opened by itself when they were added again; an owner who stepped down and was made an owner again got their own.
    - **Owners are named at creation by adding them straight after**, as step 3 foresaw: the create dialog asks only for the name, and the new group's card says to add the people who share it; "Add a person" offers the owner's role.
    - **Not offered in the interface yet:** deleting the data of a removed app. The owners' list now gives what it needs (removed and code-absent apps with their row counts); A6 puts the action in "space settings", and no step names it.
    - **Tests.** `packages/server/src/groups/routes.test.ts` (creating, renaming, adding and inviting, arriving, changing, removing, leaving, taking back, the policy setting), `groups/policy.test.ts`, `apps/access.test.ts` (the Testable line first, then the access route and the owners' list) and `membership.test.ts` (joining invited groups on arrival); `packages/web/src/groups/groups.test.tsx` (the cards, dialogs and table, in both languages, against a stand-in server); `e2e/groups.spec.ts` against the stand-in (desktop, and a phone in Chinese); and in `e2e/real-server.spec.ts` two people on the built server: a member's copy of the server shares the owner's database file, so the owner creates a group, adds the checklist for everyone to view, invites Lin, who arrives and can only view it (her mutation is 403); the owner gives her edit, she ticks an item the owner then sees ticked; with no access it is gone from her session and answers 404; allowed to add apps, she adds the feed herself, and the owners' list shows "only me for now" stored for everyone else with an `edit` exception for her.
11. **Move.** *Built.* *Reviewed.* Add the route and the dialog.
    *Testable:* rows and space settings arrive; access rows are gone; the mover's pin and own settings survive; the target having the app gives 409; the `sqlite_master` guard test.
    *As built, where it differs from A6 and A8:*
    - **The route** (`POST .../move`, `moveApp` in `packages/server/src/apps/installs.ts`) answers 204 with no body, and turns a request down in this order: 400 for a body that is not `{ toSpaceId, memberAccess? }`; 404 when `resolveInstall` gives `null` for the app where it is (a removed app and one whose code is gone included, also for an owner); 403 for anyone who does not own that space, whatever they may do with the app; 404 when the caller is not in the space `toSpaceId` names or it does not exist, one answer for both, so that a space's existence is not revealed; 403 for a plain member there without the right to add apps; 409 when the app's manifest leaves out that kind of space; 409 when that space has an entry for the app, removed or not, hidden from the caller or not, the space the app is in included. A refusal changes nothing.
    - **A mover who is not an owner of the target gets an `edit` exception there**, as when they add an app (A6 "Access"). A6's step 1 deletes every exception, so without this a member who may add apps would move her own app into a group and lose it; section D3 says it arrives "visible only to the mover and the owner until access is chosen". The exception is written after the `UPDATE`, and is the one access row a move leaves.
    - **Any space the caller owns or may add apps to**, as A6 says. Decision 3 names the case of a group's owner moving an app into their own personal space; the same rule also lets them move it into another group, and anyone move an app out of their own personal space into a group where they may add apps.
    - **What goes and what stays.** The rows with their authors and times, the settings the space shares, and the own settings, switch and pin of everyone who is in both spaces go along. Those of everyone else are deleted first (A6 step 2); the SQL for their settings is `deleteOwnSettingsOfOthers` in `store.ts`, the one file for `app_settings`. `space_apps.created_by` and `created_at` stay, so the app keeps its place among the apps of its new space by when it was first added. `memberAccess` is stored as given for a personal space too, as adding does; nobody else is in one.
    - **The guard.** The `sqlite_master` test that step 3 put in `packages/server/src/db/apps-schema.test.ts` still checks the cascading key, and gained a second check: the tables with `space_id`, `app_id` and `user_id` are exactly the three `moveApp` clears of people who are not in the target, so a new one fails a test until the move deals with it (the database would refuse every move of that app out of a group).
    - **The dialog** is on the Apps page (`packages/web/src/pages/apps.tsx`). "Move", beside "Remove", shows on a row for an owner of the space when the session shows somewhere to go: another space where the person may add apps (`canAddApps`), whose kind the manifest this build holds allows, and which does not list the app (`useMoveTargets` in `packages/web/src/apps/manage.tsx`). It offers those spaces in the session's order, the personal one first, and the first is chosen; for a group it asks who else may use the app, "only me for now" first, as adding does (owner's decision 1); it says that everything goes along and, from a group, that people who are not in the new space lose the app and their own settings for it. The server decides again: a space that holds the app hidden from the person, or kept its data from before, turns the move down and the dialog says so, with the session loaded again. After a move the session and the owners' lists of both spaces are loaded again, the row leaves its card with its dialog, and the card of the space the app went to says "Checklist was moved here." and takes the focus.
    - **Still not offered in the interface** (step 10): deleting the data of a removed app. A space that kept an app's data cannot take that app by a move until the data is deleted through its route (`DELETE .../data`), which the end-to-end test on the real server does.
    - **Tests.** `packages/server/src/apps/move.test.ts` (the Testable line first, then who may move what where, every refusal and its order, and what follows a move: adding the app again where it left, moving it back, an app without rows or a server file) and the second guard in `apps-schema.test.ts`; `packages/web/src/apps/manage.test.tsx` (the dialog both ways, where it is offered, a refusal, Chinese); `e2e/apps.spec.ts` against the stand-in (out of a group and back with the owners' table following, a refusal, Chinese, a phone); and in `e2e/real-server.spec.ts` two people on the built server: the owner's own space first answers 409 while it has the checklist and while it keeps its data; then the owner moves the group's checklist, with an item from each of them, the group's sections and both people's own setting and pin, into their own space on the Apps page and back for everyone to view. In between Lin has no access at either address; afterwards she can view the data again, her own pin and setting are gone, her old edit access did not come back, and the owner's pin and setting made both trips.
12. **Deploy and CI.** *Built.* *Reviewed.* Change the deploy script as in A7 and add a handshake-failure case to `deploy/tests/deploy.test.sh`. Add the cross-repository CI job. Update `AGENTS.md`, `docs/architecture.md`, `docs/self-hosting.md` and the server README.
    *Testable:* the deploy tests pass with stand-ins; a version mismatch leaves the old release running.
    *As built, where it differs from A7:*
    - **The deploy script** (`deploy/hearth-deploy.sh`) does what A7 sketches. After the framework's install it runs `pnpm install --frozen-lockfile --offline --store-dir <base>/pnpm-store` in the release's copy of the mini-apps, `releases/<time>/hearth-stones` beside `releases/<time>/hearth`, when that copy has a `package.json`; a repository without one, as `hearth-stones` is today, holds no apps and has nothing to install. Then `pnpm build` gets `HEARTH_APPS_DIR` naming that copy. Without `APPS_REPO` nothing is passed and the release holds no mini-apps. The journal says what each build holds, from sync's own line ("The build holds 1 mini-app (grocery).").
    - **Status 3 is read from `pnpm build`**, as A7's sketch has it, not from a sync step of its own: the build starts with `pnpm apps:sync &&`, and pnpm passes the status on (pnpm 10.28 does, through both levels). A step of its own would name a second script that the installed deploy script depends on, and the installed copy is updated by hand, after the framework it builds. A test in `packages/sdk/tools/cli.test.ts` checks that `build` starts with sync and that `pnpm apps:sync` ends with 3.
    - **Commits whose versions do not fit are not built again by themselves.** A7 says only that the old release keeps running and that the next mini-apps commit is built at once. The failure is recorded as stage `sdk` in `state/failed`, beside `build` and `live`; building the same two commits again cannot change it, so unlike other build failures they are not retried after `RETRY_AFTER_MINUTES`, and the next commit of either repository is built at once. The message names both commits and says that this is expected between the two merges; the lines of the build log after it, which the deploy prints, name both versions.
    - **An offline install that fails** stops the deploy with its own message (the lockfile must be up to date and hold nothing but the link), as a build failure, retried after the waiting time. It fails for a package that is not in the server's store; one that the framework's install already put there would install, so the import scan stays the gate (A7, "SDK only").
    - **`HEARTH_BASE` may not contain a colon while `APPS_REPO` is set**: `HEARTH_APPS_DIR` separates folders with colons, and the release would otherwise quietly hold no mini-apps.
    - **The deploy tests** (`deploy/tests/deploy.test.sh`: seven new cases, sixteen in all) run the real `hearth-apps sync`. Each made-up framework commit carries a copy of the SDK's `bin` and `tools/*.mjs` with an SDK version of its own, and the pnpm stand-in's `build` runs it, as the real build does first. In the mini-apps folder the stand-in does what pnpm does with a lockfile that holds only a `link:`: a relative link from `node_modules/@hearth/sdk`, and `ERR_PNPM_NO_LOCKFILE` when the lockfile is missing. The cases: a `HEARTH_BASE` with a colon, refused before anything is touched; mini-apps without apps (copied in, nothing installed, built with `HEARTH_APPS_DIR`); mini-apps that cannot be linked (stopped before the build, the old release running); mini-apps linked offline and built in (the link leads to the release's own SDK, the server's list holds the app); a new SDK version the mini-apps were not written for, which is the Testable line (no stop, no restart, `current` unchanged, the release that failed deleted, stage `sdk`); the same commits not built again even after the waiting time; and the matching mini-apps commit built at once. Each case was shown to fail when the behaviour it tests was taken out of the script.
    - **Tried by hand, not in the tests:** the real `pnpm install --frozen-lockfile --offline` in a folder shaped like `hearth-stones` beside a `hearth` checkout, with an empty store and the deploy's clean environment, which step 7 left untried. It makes `node_modules/@hearth/sdk` the relative link `../../../hearth/packages/sdk`, and the lockfile pnpm 10.28 writes for it is the one the deploy tests use. Then the CI job's steps, read from `ci.yml` and run in that layout with a copy of the sample `checklist`: the check passed, `pnpm build` built the app in, and the built server started with the trial start's settings. Today's `hearth-stones`, checked out beside this repository, passes the job with no apps.
    - **For step 13:** pnpm 10 switches to the pnpm version a `packageManager` field names before it installs, and fetches it when it is not the one running, `--offline` or not; without a network that waits until something stops it (tried). The made-up mini-apps of the deploy tests name none. `hearth-stones` should leave the field out, or name exactly the version `hearth` names.
    - **The CI job** (`mini-apps` in `.github/workflows/ci.yml`) checks out this commit as `hearth` and `main` of `hearth-stones` beside it, from the same owner (`github.repository_owner`, so that no account name is written down). It installs, links the mini-apps offline when `hearth-stones` has a `package.json`, runs `hearth-apps check` on them (`HEARTH_APPS_DIR=../hearth-stones`) and then `pnpm build`. A7 says "builds"; the check comes first because a build does not check types, and a break of the SDK is most often one of its types. Status 3 passes with a notice and skips the build; any other failure fails the job. It runs on every pull request and every push to `main`, like the other jobs, so a break shows on its pull request before it lands, earlier than section E expected. It has not run on GitHub yet: a push to this branch starts no workflow.
13. **`hearth-stones` bootstrap.** *Built.* *Reviewed.* Add the root `package.json`, tsconfig, ESLint config and CI; add `@hearth/sdk/testing` and `hearth-apps dev` and `test`; fill in the AGENTS.md "Layout and commands" section.
    *Testable:* `pnpm check` passes there with zero apps; CI is green.
    *As built, where it differs from A1, A7 and A9:*
    - **`@hearth/sdk/testing` holds types and a hand-over** (A1: "implementation supplied by the framework"). `testApp(server)` forwards to what the framework installed through a fourth entry point for the framework only, `@hearth/sdk/testing/host` (`provideTestApp`), which the import scan refuses in an app as it refuses `@hearth/sdk/web/scope`. The implementation is `packages/server/src/apps/app-testing.ts`; `hearth-apps test` installs it in the setup file of its run (`app-testing.setup.ts`). Without it, `testApp` throws and says to run the tests with `hearth-apps test`.
    - **What `testApp(server, { space? })` gives** (A9 shows one call): an app in a space of a database of its own, in memory and migrated like the real one. The space is a group (named "Family") unless the manifest allows only personal spaces, or the test asks for a kind. `as({ name?, access?, locale? })` is someone in it, by default "Sam" with "edit" and "en". The same name is the same person for as long as that `testApp` lasts, so `createdBy` and `mine` can be tested, and the grocery list of step 15 can be tested with two people. In a group everyone a test names is a member, and the group's owner (a person of the test world's own, who never calls) sets each caller's access before each of their calls, through the access route's own function: so one person can be had with view and with edit. A personal space has one person, who always has edit.
    - **A caller** has `query(name, input?)`, `mutation(name, input?)`, `settings()`, `saveSettings(values)` and `user` (`id`, `name`), typed from `typeof server`. A call goes through what the routes use: `callApp` (access check, input check, `ctx`, store, transaction) and, for settings, `readAppSettings` and `changeAppSettings`, with the input and the answer passed through JSON. Settings are by name as `ctx.settings` has them, and saving sends each under its scope, as the settings form does. Settings are not in A9; without them an app whose handlers read `ctx.settings` (GitHub trending) could not be tested. The app is checked first as the server checks it at start-up, so an app that would stop a deploy fails its tests too.
    - **A refusal throws `AppCallError`** (`status`, `code`), whose message starts with the code, so that `expect(() => ...).toThrow("forbidden")` says what it means. A handler's fault (another error, a promise, an answer that is not JSON) throws the `AppFaultError` the server would log, and the test fails.
    - **`hearth-apps test`** (`packages/sdk/tools/test.mjs`) works on the folders `check` works on (`HEARTH_APPS_DIR`, or the folder it runs in). It makes sync's checks first and writes nothing, so a folder written for another SDK version ends with status 3 and an app the build would refuse has its tests not run. Then one run of the server package's vitest with `packages/server/vitest.apps.config.ts`: a project for each apps folder, holding the `*.test.*` files of its apps (`.test.` and a JavaScript or TypeScript extension, the scan's own `TEST_FILE`) except in `node_modules` and hidden folders, which the scan does not read either. It ends with 0, or 1 when a test fails.
    - **`check` runs the tests** as its fifth stage, after lint (A7 lists vitest; step 7 left it out). Every stage still runs when an earlier one fails, so a server file the start-up check refuses fails the app's tests as well.
    - **`hearth-apps dev`** (`packages/sdk/tools/dev.mjs`) runs sync for the same folders, then `pnpm dev` in the `hearth` checkout with `HEARTH_APPS_DIR` naming them, `HEARTH_AUTH=dev`, and `HEARTH_OWNER_EMAIL` as set or else `you@example.com`. What sync refuses starts nothing and ends with sync's status. The servers run in a process group of their own, and a stop signal that reaches the command goes to the whole group: pnpm does not pass one on through the shell and `concurrently` below it, so a SIGTERM to the command alone left both servers running until this was fixed. **From the review:** a stop sent to a mini-apps repository's `pnpm dev` alone (`kill`, or a tool that signals pnpm's process and not its group) still did not reach the command, for the same reason one level up: pnpm passes SIGTERM and SIGINT only to the shell it runs the script in, and that shell (dash, as `/bin/sh` on Debian and Ubuntu) keeps an interrupt to itself and dies of SIGTERM alone, which left the command and both servers running on their fixed ports. The script in `hearth-stones` is now `exec hearth-apps dev`, which puts the command in the shell's place, and the command also stops the servers once the process that started it is gone (checked every second), which covers a pnpm that dies of SIGHUP or SIGKILL without passing anything on. Ctrl+C stopped everything before and still does; with `exec` it reaches the command twice at once, from the terminal and from pnpm, so the same signal is passed on only once within half a second, because a second SIGINT makes tsx kill the server before it has closed its database. Tried by hand, from a folder of apps outside the checkout: a change to a widget showed on the dashboard without the page reloading (a Playwright script), and a change to `server.ts` restarted the server. An app, page or server file added or taken away changes the lists sync wrote at the start, so it needs the command started again. It refuses `--out`: the dev servers read the lists where a build writes them.
    - **`vitest` is a dependency of the SDK now**, and `tsconfig.app.json` leads `vitest` to the SDK's copy, so that a mini-apps repository type-checks its tests with nothing installed but the link. The types that name an app's routes (`QueryName`, `MutationName`, `InputArgs`, `Output`, `AppLike`) moved from `src/web/hooks.ts` to `src/routes.ts`, which needs no React, so the tests' types share them; `@hearth/sdk/web` exports them as before. The SDK's version stays 0.1.0: nothing was taken away or changed.
    - **The sample `checklist` has tests** (`checklist.test.ts`), the first ones written with `testApp`, which the template of step 14 copies. `packages/fixture-apps` gained `pnpm test`, which the root `pnpm test` runs.
    - **`hearth-stones`** has A1's `package.json`, with `check`, `test` and `dev` (step 14 added `new`; `dev` is `exec hearth-apps dev` since the review), a `license`, and no `packageManager` field, as step 12 advised; the lockfile pnpm 10.28 writes for it, which holds the link only and is the one the deploy tests use; the one-line `tsconfig.json` and `eslint.config.js`; CI; and its AGENTS.md "Layout and commands" and README.
    - **CI there** (`.github/workflows/ci.yml` in `hearth-stones`) is A7's: `main` of `hearth` checked out beside it, from the same owner; `hearth` installed, then the link installed `--frozen-lockfile --offline` as the deploy does; `pnpm check`, with a note to merge the SDK change into `hearth` first when it ends with status 3; then `pnpm build` in `hearth` with `HEARTH_APPS_DIR=../hearth-stones`. Hosted runner, pinned actions, no secrets, a read-only token.
    - **"CI is green" is not shown yet, and cannot be before this work is on `main` of `hearth`**: that `main` holds the app shell only, without the SDK, so the job fails until the owner merges `hearth` first, as for any change here that `hearth-stones` depends on. The job's steps were replayed by hand in a fresh side-by-side copy of both repositories with this branch as `hearth`: they passed with no apps, ended with status 3 and the note for apps declaring another SDK version, and passed and built with a copy of the sample checklist. `hearth`'s own `mini-apps` job passed against this `hearth-stones` in the same way. Neither has run on GitHub.
    - **Tests.** `packages/sdk/src/testing.test.ts` (the types of a caller, and the hand-over); `packages/server/src/apps/app-testing.test.ts` (the framework's implementation: calls as the routes answer them, people and their access, refusals and faults, JSON, settings, personal spaces, apps the server would refuse); `packages/sdk/tools/cli.test.ts` (`test` and `check` running tests from a repository beside the checkout, a failing test, which files count, several folders, refusals; `dev`'s refusals; and the Testable line itself: a repository set up as `hearth-stones` is, beside a folder named `hearth`, installed with the real `pnpm install --frozen-lockfile --offline`, passes `pnpm check` with no apps, and with a copy of the sample checklist); `packages/sdk/tools/dev.test.ts` (what `dev` syncs and starts, with the start replaced, and that a stop reaches every process below the real start: a stand-in `pnpm dev` whose child holds a port, free again afterwards; since the review also the real `pnpm dev` of a repository set up as `hearth-stones` is, beside a stand-in for `hearth` with that stand-in as its servers, with SIGTERM, SIGINT, SIGHUP and SIGKILL each sent to pnpm alone and each freeing the port, and Ctrl+C sent to the group reaching the stand-in servers once. Without `exec` in the script three of the four signals fail, without the check of the parent two, without both all four; passing every signal on makes the servers get Ctrl+C twice).
14. **Template and scaffold.** *Built.* *Reviewed.* Build-order step 3: `hearth-apps new <id>` copies `checklist`.
    *Testable:* a scaffolded app passes `check` untouched.
    *As built, where it differs from A1 and A9:*
    - **What the copy changes** (`packages/sdk/tools/new.mjs`): only what makes it another app. Its folder is named after the new ID; the manifest's `id` is the new ID; `checklist.test.ts` becomes `<id>.test.ts`, and the name its tests are listed under changes with it; its `package.json` is named after the repository and the ID, `@hearth-stones/<id>` as A1 has it (the bare ID when the repository's own name cannot be a scope); its `README.md` is written new, because the checklist's is about the sample app: it says where the app came from and what to change, file by file.
    - **Everything else stays the checklist's**: the name, description and strings in both languages, the icon and colour, the settings, the collection and routes, the widget, the page and the tests. So the copy is a working app that passes `check` from the first moment, and it is called "Checklist" until its author changes the manifest. A name made from the ID was left out: it would exist in English only, against the rule that every interface string exists in both languages.
    - **Which folder**: as for `check`, `test` and `dev`, the one `HEARTH_APPS_DIR` names, or the folder the command runs in. A new app goes into one folder, so it refuses when the variable names several. The folder must be one sync takes apps from, asked through sync's own `handshake`: a `package.json` with an SDK version this checkout fits (else status 3, as everywhere) and `@hearth/sdk` linked to this checkout. The `hearth` checkout itself is refused with a pointer to `hearth-stones`.
    - **It overwrites nothing and writes nothing when it refuses.** An ID outside the pattern of A1 is refused (status 1), and so is a name that is taken by anything: an app, a folder, a file or a link. No ID or more than one is a usage error (status 2). The files are written into a hidden folder beside the app's place and renamed into place, so an app appears whole or not at all, and a write that fails leaves nothing behind; sync never reads a hidden folder.
    - **The template is read where it is**, `packages/fixture-apps/checklist` of the checkout the command belongs to, when the command runs. The SDK keeps no copy of it, so a change to the sample app reaches every app made after it. The two texts the copy changes must each be in the template exactly once (`id: "checklist",` in the manifest, `describe("checklist",` in the tests): when a change to the checklist moves one, `new` stops, says that the checkout is at fault, and its tests fail.
    - **`hearth-stones` gained the script `new`**, so that A9's `pnpm new stocks` works there. `--out` changes nothing for `new`, as for `test`: it writes none of the generated lists. A running `pnpm dev` does not see the new app until it is started again (step 13).
    - **Tests.** `packages/sdk/tools/new.test.ts`: the copy file by file against the checklist, its README, a copy beside other apps, the package name; every refusal, each leaving the folder as it was; a template it no longer understands; a write that fails. `packages/sdk/tools/cli.test.ts`: the Testable line as the command is run, an app made where the command runs and one in the folder `HEARTH_APPS_DIR` names, both passing `check` untouched; the refusals and status 3; and in a repository set up as `hearth-stones` is, beside a folder named `hearth`, `pnpm new stocks` and then `pnpm check`. The test that expected `new` to say it was not built now finds it in the usage. Each change the copy makes and each refusal was taken out of `new.mjs`, or of the command line in `bin/hearth-apps.mjs`, one at a time, and the tests for it were seen to fail.
    - **Tried by hand:** in a fresh copy of `hearth-stones` beside this checkout, linked with `pnpm install --frozen-lockfile --offline`, `pnpm new stocks` and then `pnpm check` passed; Hearth built with it (`HEARTH_APPS_DIR` naming that copy) held it, and the built server added it to a personal space and answered its mutation and query under the new ID.
15. **Grocery list.** *Built.* *Reviewed.* Build-order step 4.
    *Testable:* app tests with `testApp`; e2e of two family members sharing a list.
    *As built, where it differs from A1, A2, A3, A4 and A9:*
    - **The app is `hearth-stones/grocery`**, started with `pnpm new grocery` (step 14) and then changed file by file: A2's manifest, A3's collection and four routes, A4's widget (with "{count} left" under it, as the checklist has) and the page A4 describes: the form to add an item with a row of the space's aisles to choose from, one `Rows` per aisle in the settings' order and "Other" last, and "Clear ticked". Someone with view access gets the list and nothing to press. It declares no `spaces`, so it can be added to a personal space too.
    - **The manifest adds three things to A2's.** `maxLength: 40` on `aisles`: an item's `aisle` is at most 40 characters, so a longer aisle would make every item added under it fail. And two strings: `submit`, the form's button, as the checklist gained in step 8, and `aisle`, which names the row of aisles for a screen reader.
    - **`add` does not put the same thing on the list twice** (A3's `add` always inserts). A name that is on the list already, in another case, with other spaces or in full-width letters ("milk", " Milk ", "ＭＩＬＫ"), is that item: it is unticked if it was ticked, it moves to the aisle given if one is, and it is returned. So two people who both add milk before either sees the other's change get one milk, and something bought last week comes back in its place when it is needed again. The check reads the list inside the mutation's immediate transaction, so two adds at the same moment cannot both insert; the route's `description` says what it does.
    - **No other route.** There is no rename, no deleting a single item and no quantity: a mistyped item is ticked and cleared. A tick of an item someone else cleared meanwhile is 404 `not_found` (from `update`); the shell then reads the list again (step 9).
    - **The page groups by each aisle once.** A list setting may hold the same text twice and an entry someone emptied (step 6, and the settings form allows both), which would have drawn items twice; the page leaves out repeats and empty entries, and an aisle chosen in the form that someone has since taken out of the settings is no longer sent. The sample checklist's page, which `hearth-apps new` copies, had the same fault with its sections and is fixed the same way, with a stand-in test in `e2e/widgets.spec.ts`.
    - **Tests of the app** (`grocery/grocery.test.ts`, with `testApp`, run by `pnpm check` there): two people on one list, view against edit access, ticking, unticking and clearing for everyone, the same item added twice and added again after it was ticked, a tick of an item someone else cleared, names and aisles that are turned down, the space's aisles against each person's own switch, the limits on aisles, and a personal space. Each behaviour was taken out of the app in turn, and a test failed each time.
    - **The end-to-end test is in this repository, not beside the app.** A1 and A9 give a mini-apps repository no end-to-end tests, and `hearth-stones` installs nothing but the link to the SDK, so it has no Playwright; the end-to-end tests here already run two people over one database. `playwright.mini-apps.config.ts` (`pnpm e2e:mini-apps`) builds Hearth with the mini-apps of `HEARTH_APPS_DIR`, or of `hearth-stones` beside this checkout, as the deploy builds the two; starts the owner's and Lin's copies of the server over a database file of their own, on ports of their own (4183 and 4184); and runs `e2e/mini-apps/<id>.spec.ts` for each app those folders hold, so a `hearth-stones` without the grocery list runs nothing and passes. `pnpm e2e` leaves that folder out. CI's `mini-apps` job runs it after its build; CI in `hearth-stones` does not, because the test lives here: a change there to the grocery list's texts or layout shows in the next run of this repository's CI, so whoever makes one runs `pnpm e2e:mini-apps` here first and changes the test with it. Giving mini-apps end-to-end tests of their own, beside them (an entry point of the SDK and a `hearth-apps e2e`, as `testApp` and `hearth-apps test` are for their unit tests), is for the owner to decide.
    - **`e2e/mini-apps/grocery.spec.ts`** is the Testable line. The owner creates a group, invites Lin, adds the grocery list on the Apps page for everyone to edit, gives it two aisles in its settings and adds milk and bread under them. Lin, on a phone and in Chinese, finds both on her dashboard and the aisles on the page, adds eggs, adds "milk" (still one milk) and ticks the milk; the owner's page, left open, shows each change once the list is read again after 15 seconds (Playwright's clock), without a reload. Lin's own "Hide ticked items" hides the milk from her alone; the owner clears what was bought; Lin's dashboard keeps what is still to buy, and every row names who wrote it. A second test checks the page against a list of aisles with a repeat and an empty entry, and an item whose aisle the space no longer has. Taking out the merge in `add`, `hideDone` in the page or the shell's polling made the first test fail; taking out the page's de-duplication, the second.
    - **Tried by hand:** Hearth built with `hearth-stones`, a sample list on the built server, and the dashboard and the page looked at on a desktop and a phone, in light and dark.
    - **Two changes in the end-to-end tests' own code:** the command that starts a copy of the built server is `realServerCommand` in `e2e/servers.ts`, shared by both configurations, and the addresses of the new run are there too.

---

## C. Scheduled jobs and outbound fetch

Build-order item 5, designed before any of it was built. The owner's decisions 8 to 15 come first, and the rest of this section follows from them. Where section A differs (A3 reserved the builder name `job` without designing it, A4 sketched the trending app with each person's languages), this section wins. Its build plan, at the end, marks each step once built.

### Owner's decisions for section C (these override anything below that disagrees)

8. **Scheduled jobs, then GitHub Trending.** Build-order item 5 is jobs in
   the framework, then a "GitHub Trending" mini-app in `hearth-stones`, to
   "let me know the latest popular projects".
9. **"Popular" means new and rising:** repositories created in the last
   day, week or month with the most stars, overall and per language, from
   GitHub's official REST search API (`GET
   https://api.github.com/search/repositories` with `q=created:>=DATE ...`,
   `sort=stars`, `order=desc`). GitHub has no trending API. Its Trending web
   page is never scraped, and no third-party trending service is used.
10. **Spam is filtered three ways.** The query asks for `fork:false
    archived:false` and a minimum number of forks for each range
    (`forks:>=10` was measured to remove most spam for a week; day and month
    are scaled from it). A small deny-list of names and descriptions drops
    the known patterns ("XYZ 2026: Full-Feature Desktop Installer", crypto
    mint bots, "Fake-Balance" wallet tools). Each space keeps a Hide list
    that people with edit access add to and undo, and the app always
    applies it.
11. **A widget and a full page with filters, refreshed every hour.** No push
    notifications and no email.
12. **GitHub's limit is shared, and kept to.** Unauthenticated search allows
    10 requests a minute for the server's IP address, shared by every space.
    Requests are paced to stay within it; a run stops at a 403 or 429
    rate-limit answer and the previous results stay. No GitHub token for now.
13. **The approved look** is the mockup's GitHub Trending page: a range
    control (Today / This week / This month), language chips, and rows with
    rank, owner/name linked to GitHub (in a new tab), a one-line description
    (a person may hide descriptions), language, stars, forks and how old the
    repository is; "Updated 12 min ago"; when the last refresh failed, a
    banner ("Couldn't reach GitHub at 14:05. Showing results from 13:05.")
    with a retry for people with edit access; an empty state before the
    first results. English and Simplified Chinese.
14. **What a job is.** An app declares the exact hosts its jobs may contact,
    and the add dialog shows them. Jobs sit beside the queries and
    mutations, each with a one-sentence description and how often it runs.
    A job may be asynchronous because it fetches; handlers stay synchronous.
    A job never holds a transaction across an `await`: it fetches with
    `ctx.fetch`, then writes through a synchronous callback that runs in one
    immediate transaction with a store scoped to its space and app, checks
    again that the app is still there (not removed, not moved away, its code
    in the build), and is closed when the callback returns. A job runs once
    per install, not per person, and sees the space's settings, nobody's
    own. `ctx.fetch` allows https and the declared hosts only, no redirect
    to another host, has a timeout and a cap on an answer's size, passes on
    no cookies and no identity headers, and sends a fixed User-Agent naming
    Hearth. A mini-app still may not use the global `fetch`.
15. **The scheduler** runs in the server process: due jobs one at a time
    across the whole server, with jitter, a time limit for each run and
    backoff after failures, and each install's job status in the database,
    surviving restarts. A setting turns it off: the deploy script passes it
    to its trial start against the copied database (with a deploy test), and
    tests run no job unless one asks. It runs under `pnpm dev`; stand-in
    answers for end-to-end tests can be switched on only with
    `HEARTH_AUTH=dev`. View access reads a job's status; edit access asks for
    a run now, debounced. The hooks give what "Updated N min ago", the
    failed-refresh banner and "Refresh now" need, and an app's own tests run
    a job with stand-in answers through the scheduler's own code. The SDK
    becomes 0.1.1 (an additive change is a patch); `hearth` is merged first,
    then `hearth-stones`.

### The manifest's hosts

```ts
// @hearth/sdk: added to Manifest
/** The hosts the app's jobs may fetch from, as lower-case DNS names ("api.github.com"). Shown to whoever adds the app. */
network?: readonly string[];
```

- **The schema** takes 1 to 10 different names, each a lower-case DNS name of two or more labels (letters, digits and hyphens; at most 63 characters a label and 253 in all; the last label letters only). So there is no scheme, port, path, wildcard or IP address; `localhost` and names ending in `.localhost`, `.local`, `.internal` or `.home.arpa` are refused too. `createRegistry` refuses hosts in an app that defines no job: the dialog would announce a connection that never happens.
- **The add dialog** shows them under the app's description, for a new app and for one brought back: "Fetches data from api.github.com on its own." / "会自行从 api.github.com 获取数据。" (`apps.addNetwork`; hosts joined with ", " and "、"). It asks nothing more: the app is trusted code that the server's owner checked out (section E).

### Jobs in the server file

```ts
// @hearth/sdk/server: added
export type JobAbout = {
  /** One English sentence saying what the job does, for a reader who has not seen the app. */
  description: string;
  /** How often it runs, in minutes: a whole number from 15 to 10080 (a week). */
  everyMinutes: number;
};

/** A job as the framework reads it: made with `app.job`, listed in `app.routes`. */
export type Job = {
  readonly kind: "job";
  readonly description: string;
  readonly everyMinutes: number;
  readonly run: (ctx: never) => unknown;
};

/** What a job's function gets. A job runs for the app in one space, for no one in it. */
export type JobCtx<M, C extends Collections> = {
  /** The space the app is in. A personal space has an empty name. There is no ID. */
  readonly space: { readonly kind: SpaceKind; readonly name: string };
  /** The space's settings, defaults filled in, as they were when the run started. Nobody's own. */
  readonly settings: SpaceSettingsOf<M>;
  /** When the run started. */
  readonly now: Date;
  /** GET from a host the manifest lists in `network`. */
  fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
  /** Reads the app's rows in this space in one transaction. `work` must not be async. */
  read<T>(work: (db: { readonly [K in keyof C]: ReadCollection<z.output<C[K]>> }) => T): T;
  /** Changes them in one immediate transaction, all of it or none. `work` must not be async. */
  write<T>(work: (db: { readonly [K in keyof C]: Collection<z.output<C[K]>> }) => T): T;
};

export interface ServerBuilder<M, C extends Collections> {
  // query and mutation as built in step 5
  /** Something the app does by itself, every `everyMinutes`, once for each space it is in. */
  job(about: JobAbout, run: (ctx: JobCtx<M, C>) => Promise<void> | void): Job;
  /** The app's queries, mutations and jobs by name: one set of names for the three. */
  routes<R extends Record<string, Query<any, any> | Mutation<any, any> | Job>>(routes: R): AppServer<M, C, R>;
}

// @hearth/sdk: added
export type SpaceSettingsOf<A>;   // the settings of scope "space" only, typed as in SettingsOf
// @hearth/sdk/web, from src/routes.ts: added
export type JobName<S>;           // the names of an app's jobs; QueryName and MutationName leave them out
```

- **One set of names.** A job is listed in `app.routes(...)` beside the queries and mutations, so no name is used twice, and the future assistant (decision 7) reads every description in one place. A job is never callable as a route: `/q/` and `/m/` answer 404 for its name, as for a query asked for as a mutation.
- **`checkServer`** checks every job, at start-up and in `hearth-apps check`: made with `app.job`, a description that is not empty, `everyMinutes` a whole number from 15 to 10080, no `input`.
- **How a run ends.** It went well when the function returned or its promise resolved. Whatever it throws or rejects with makes it fail, recorded with the first 200 characters of its message and logged with the app, the job and the space's ID. `AppError` means nothing special to a job.
- **`ctx.read` and `ctx.write`** run `work` in one transaction, deferred for `read` and immediate for `write`. First, inside it, they check that the run may still touch the install: the app's entry is in the space the run started in and not removed, the build holds the app and the job, the run still holds its claim (see "Running a job") and its time limit has not passed. Otherwise they throw and nothing is read or written. `work` gets a store built as a handler's is (`readOnlyStore`, `writableStore`), closed when `work` returns; a `work` that returns a promise is a fault, its transaction undone and the run failed. So no transaction waits on the network, and nothing is written after a removal, a move or a deletion. Once the run is over, `ctx.fetch` rejects with `stopped`, and `read` and `write` throw.
- **A job's rows** carry the ID of the person who added the app to the space (`space_apps.created_by`), on whose behalf the job runs, and the time of the write: every row keeps a space and an author, and no made-up person goes into `users`. In a job's store `list({ mine: true })` is a `StoreUsageError`: a job is no one.
- **`ctx.settings`** is read when the run is claimed, by a new `spaceSettingsFor` in `settings.ts` (the space's object only, through a new `readSpaceSettingsData` in `store.ts`) with the routes' own `fill`. A change during a run counts from the next run.

### `ctx.fetch`

```ts
// @hearth/sdk/server: added
export type FetchInit = {
  /** Extra headers: accept, accept-language, if-modified-since, if-none-match, and names starting with "x-" but for x-forwarded-* and x-real-ip. */
  readonly headers?: Readonly<Record<string, string>>;
};
/** An answer, read whole. A status that is not 2xx is an answer like any other, not an error. */
export type FetchResponse = {
  /** Where the answer came from, after redirects on the same host. */
  readonly url: string;
  readonly status: number;
  /** The status is 200 to 299. */
  readonly ok: boolean;
  /** Header names in lower case; set-cookie is left out. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body, as UTF-8 text. */
  readonly text: string;
  /** The body parsed as JSON; throws when it is not JSON. */
  json(): unknown;
};
export const FETCH_ERROR_CODES = ["refused", "timeout", "too_large", "network", "stopped"] as const;
export class FetchError extends Error {
  readonly code: (typeof FETCH_ERROR_CODES)[number];
}
```

The rules, all in `packages/server/src/apps/fetch.ts`:

- **GET only**, to `https:` on the default port, without a user name or password, to a host the manifest lists, exactly. Anything else is `refused` before it is sent.
- **Headers.** `User-Agent: Hearth` and the headers `FetchInit` allows, nothing else; any other header from the app (`Authorization`, `Cookie`, `Host`, `Origin`, `Referer` ...) is `refused`. A job has no person's request behind it, so there is nothing of a person's to pass on, and no cookies are kept between requests.
- **Redirects** are followed up to 3 times while they stay on `https:` and the same host; any other is `refused`.
- **Limits.** 20 seconds for a whole answer (`timeout`); 2 MiB of body, counted after decompression, beyond which the download stops (`too_large`). DNS, connection and TLS failures are `network`.
- **Pacing.** Requests to one host start at least 6.5 seconds apart, across every app, install and job of the server: at most 10 a minute, GitHub's unauthenticated search limit (decision 12). The wait counts against the run's time limit. A host therefore takes about 550 requests an hour, enough for 16 installs of the trending app that each follow 10 languages; more installs push their runs further apart than an hour.
- **One transport**, a function from a checked request to an answer, so that the rules are tested without a network: Node's `fetch` with `redirect: "manual"` on a server, the stand-in file in end-to-end tests (see "Switches"), a test's own function in `testApp`. Stand-ins answer at once and are not paced.
- **The global `fetch` stays refused** by `no-restricted-globals`, whose message becomes "A mini-app fetches in a job, with ctx.fetch, from the hosts its manifest lists."; the import scan still refuses `node:http` and every package. It is not a sandbox (section E).

### Running a job

`packages/server/src/apps/jobs.ts`. The scheduler and `testApp` run a job through the same three functions, and nothing else runs one.

1. **`claimRun`**, one immediate transaction: the app's entry is in the space and not removed, the build holds the app and the job, the job is due (or the caller forces it, as `testApp` does), and no run holds it whose `run_until` is still ahead. It sets `run_id` (a new ID), `run_until` (now + the time limit + 1 minute) and `last_started_at`, clears `requested_at`, and reads the space's kind, name and settings. A claim left by a server that died is taken over once its `run_until` has passed, and counts for nothing.
2. **The run**, outside any transaction: the job's function with its `ctx`. After 5 minutes it is aborted: `ctx.fetch` rejects with `stopped`, `read` and `write` throw.
3. **`recordRun`**, one immediate transaction, which finds the row by `run_id` (the row follows the app if it moved):
   - went well: `last_succeeded_at` = now, `failures` = 0, `next_run_at` = the run's start + `everyMinutes` × (1 + r/10), r random from 0 to 1 (the jitter), or now + 1 minute when that has passed;
   - went wrong: `last_failed_at` = now, `last_error` = the message cut to 200 characters, `failures` + 1, `next_run_at` = now + min(`everyMinutes`, 5 × 2^(`failures` − 1)) minutes with this failure counted (the backoff: 5, 10, 20, 40, 60, 60 ... for an hourly job);
   - the server stopped it, or meanwhile the app was removed, left the space or had its data deleted (its `write` was refused, so nothing of the run was kept): nothing is recorded, and wherever the app now is, if anywhere, the job is due at once;
   - in every case `run_id` and `run_until` are cleared.

**Asking for a run** (`requestRun`, one immediate transaction, after `resolveInstall` gives edit): unless a run is going on, `requested_at` = now and `next_run_at` = the earlier of itself and max(now, `last_started_at` + 5 minutes). A run asked for starts at once, or 5 minutes after the last one started, never sooner, so "Refresh now" cannot hammer a host; a request is never refused for being early, and during a run it changes nothing.

**The status** (`jobStatus`) is the row as the route answers it: `state` is `running` while a run holds the job and its `run_until` is ahead, `requested` while `requested_at` is set, else `idle`. A job that has not run in an install has no row there, and answers nulls, `nextRunAt` = now and `idle`.

The scheduler asks whether an install is there (its entry, not removed, its code in the build), never who may use it: `resolveInstall` stays the one answer to what a person may do. Its one query across spaces reads `space_apps` and `app_jobs` and nothing else; an app's rows and settings are read and written one install at a time, through `store.ts`.

### The scheduler

`packages/server/src/apps/scheduler.ts`, started by `main.ts` once the server listens, when `HEARTH_JOBS` is `on`.

- **One run at a time on the whole server.** It takes the job with the earliest `next_run_at` among installs whose entry is there and not removed and whose app and job the build holds; ties go by space ID, app ID and job name. A job that has never run in an install is due at once (its row is made then).
- **Idle**, it sleeps until the earliest `next_run_at`, at most 30 seconds, and wakes at once when this process is asked for a run or an app is added or brought back.
- **Timing** is `recordRun`'s: at most 5 minutes a run, a regular run up to a tenth of its interval late (jitter), and after failures in a row 5, 10, 20 ... minutes, never more than the interval (backoff).
- **The claim is in the database**, so a run stays single when two server processes share one database file, as the owner's and Lin's copies do in the end-to-end tests.
- **Restarts.** All it knows is in `app_jobs`: after a restart what is due runs, in order, and a run cut off by a crash is taken over once its `run_until` has passed.
- **Stopping.** On SIGTERM or SIGINT `main.ts` stops it before closing the database: no new run starts, the current one is aborted and its job left due at once, and the database is closed within 5 seconds whatever the job does.
- **Logs.** One line for each run that went wrong (app, job, space ID, message); none for runs that went well.
- It is given its clock, its randomness and its transport, so that its tests run without waiting and without a network.

### Switches

- **`HEARTH_JOBS`**: `on` (the default) or `off`. Off, no job runs; the status still answers, and a run asked for waits until jobs run again.
- **The trial start** gets `HEARTH_JOBS=off` from `deploy/hearth-deploy.sh`, so a release on trial against a copy of the database fetches nothing. The made-up server of `deploy/tests/deploy.test.sh` records the value it was started with, and a case checks it: `off` for the trial, unset for the live service.
- **Tests.** `createApp` starts no scheduler; only `main.ts` does. Every command in `e2e` that starts a real server sets `HEARTH_JOBS=off` unless it gives stand-ins, as must anything else automated that starts one. `pnpm dev` runs jobs against the real hosts (decision 15).
- **`HEARTH_FETCH_STANDINS`**: the path of a JSON file whose stand-ins answer every `ctx.fetch`, so that nothing reaches the network. `loadConfig` refuses it unless `HEARTH_AUTH=dev`, which itself needs a loopback `HOST`, so a real server cannot have it, and `main.ts` warns at start-up that it is on. With it, requests are not paced and a run asked for may start 5 seconds after the last one started, so that an end-to-end test can refresh twice. The file is read again at every request, so a test changes the answers by writing it:

  ```json
  [
    { "url": "https://api.github.com/search/repositories", "query": { "q": "language:rust" },
      "status": 403, "body": { "message": "API rate limit exceeded" } },
    { "url": "https://api.github.com/search/repositories", "body": { "items": [] } },
    { "url": "https://feeds.example.com/headlines.json", "error": "network" }
  ]
  ```

  The first entry whose `url` is the request's address without its query, and each of whose `query` texts is part of that parameter of the request, answers: `status` (200 when left out), `headers`, and `body`, sent as is when it is text and as JSON otherwise; or `error`, `network` or `timeout`. A request no entry answers fails as `network`. `ctx.fetch`'s rules come first, so a stand-in cannot open a host the manifest does not list.

### Table (migration 3, `app-jobs`)

```sql
-- One app's job in one space: when it runs next and how its runs went. No row: it has not
-- run there yet. Status, not data: it follows the app to another space and goes with its entry.
CREATE TABLE app_jobs (
  space_id          TEXT NOT NULL,
  app_id            TEXT NOT NULL,
  job               TEXT NOT NULL,     -- its name in the app's server.ts
  next_run_at       TEXT NOT NULL,
  requested_at      TEXT,              -- someone asked for a run that has not started
  run_id            TEXT,              -- the run that holds the job now
  run_until         TEXT,              -- when that run counts as lost: its start + the time limit + 1 minute
  last_started_at   TEXT,
  last_succeeded_at TEXT,              -- when the last run that went well ended
  last_failed_at    TEXT,              -- when the last run that went wrong ended
  last_error        TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
  failures          INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),   -- in a row, for the backoff
  PRIMARY KEY (space_id, app_id, job),
  CHECK ((run_id IS NULL) = (run_until IS NULL)),
  FOREIGN KEY (space_id, app_id) REFERENCES space_apps (space_id, app_id)
    ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;
```

- A move carries it along and deleting an app's data takes it away; the guards of `apps-schema.test.ts` hold it to both. Removing the app keeps it, the scheduler passes the app by, and bringing it back resumes it. It has no `user_id`, so `moveApp` has nothing to clear in it.
- Its SQL is in `jobs.ts`; the app's rows are still written by `store.ts` alone.

### Routes

```
GET  /api/spaces/:spaceId/apps/:appId/jobs/:job        view: the job's status
POST /api/spaces/:spaceId/apps/:appId/jobs/:job/run    edit: ask for a run; 202 with the status
```

- 404 when `resolveInstall` gives `null`, the app has no server file, or it has no job of that name (a query's name included); then 403 `forbidden` for a run asked for with view. The POST takes no body.

```ts
// @hearth/shared: the answer of both
export const jobStatusSchema = z.object({
  lastStartedAt: z.string().nullable(),
  /** When the last run that went well ended: the app's data is from then. */
  lastSucceededAt: z.string().nullable(),
  /** When the last run that went wrong ended. */
  lastFailedAt: z.string().nullable(),
  /** Why, in English, for owners and logs; never interface text. */
  lastError: z.string().nullable(),
  nextRunAt: z.string(),
  state: z.enum(["idle", "requested", "running"]),
});
```

### Hooks

```ts
// @hearth/sdk/web: added to AppHooks<S>
useJob<K extends JobName<S>>(name: K): JobState;

// src/routes.ts, so that the tests' types share it
export type JobState = {
  /** When the last run that went well ended: the data is from then. Null before the first. */
  succeededAt: string | null;
  /** When the last run ended, if it went wrong; null when it went well or none has ended. */
  failedAt: string | null;
  /** A run is going on, or was asked for and has not started: show "Refreshing…". */
  running: boolean;
  /** Whether this person may ask for a run: edit access. */
  canRun: boolean;
  /** Asks for a run. Resolves once the server has the request, not when the run is done; a refusal is reported as a mutation's is. */
  run(): Promise<void>;
  /** From run() until the server answered. */
  pending: boolean;
};
```

- `useJob` suspends until the first status is there, like `useQuery`; the shell draws the skeleton and the failed state.
- `<AppScope>` reads the status with the app's queries (every 15 seconds while visible, and on focus), every 3 seconds while `running`, and at once after `run()`. When `succeededAt` changes, every query of the app here is read again, so new data shows without a reload. The status is cached under `installQueryKey`.
- `failedAt` is `lastFailedAt` when that is later than `lastSucceededAt`, or there is none. `lastError` is not handed to the app: what a person reads comes from the app's own strings, in both languages.
- `AppScopeValue` (`@hearth/sdk/web/scope`) gains `useJob(name)`; the hook holds no logic, like the others.

### Testing

```ts
// @hearth/sdk/testing: added
/** A request a job made, as a stand-in sees it: the headers are those sent, User-Agent included. */
export type StandInRequest = { readonly url: string; readonly headers: Readonly<Record<string, string>> };
/** Its answer: status 200 unless given; a body that is not text is sent as JSON. Throwing fails it as the network would. */
export type StandInAnswer = { status?: number; headers?: Record<string, string>; body?: unknown };
export type StandInFetch = (request: StandInRequest) => StandInAnswer | Promise<StandInAnswer>;
export type JobRun = { ok: true; error: null } | { ok: false; error: string };

// TestApp<S>: added
/** Runs a job now, as the scheduler does, with `fetch` answering its requests. `now` is when it starts and ends. */
runJob<K extends JobName<S>>(name: K, options: { fetch: StandInFetch; now?: Date }): Promise<JobRun>;
// TestCaller<S>: added
/** The job's status as useJob shows it to this person. */
job<K extends JobName<S>>(name: K): Omit<JobState, "run" | "pending">;
/** Asks for a run, as "Refresh now" does: needs edit. Gives the status afterwards. */
requestRun<K extends JobName<S>>(name: K): Omit<JobState, "run" | "pending">;
```

- `runJob` goes through `claimRun`, the run and `recordRun`, forced (due or not, but never beside another run of the job), with `ctx.fetch`'s rules in front of the stand-in, no pacing, and the 5-minute limit. `job` and `requestRun` go through the routes' functions. A job that would fail on the server fails its test.

### What is enforced where

| What | Where |
|---|---|
| Hosts are plain DNS names, at most 10 | `manifestSchema`: at start-up and in `hearth-apps check` |
| Hosts come with a job; a job has a description and runs every 15 minutes to a week | `createRegistry` and `checkServer`, in the same two places; the types |
| A job reaches only its manifest's hosts, over https, as Hearth, with nothing of a person's | `ctx.fetch` (`fetch.ts`), at every request |
| A mini-app has no other way out | ESLint's `no-restricted-globals` (`fetch`) and the import scan (`node:*`, packages); not a sandbox |
| A job reads and writes its install's rows only, and only while the install is there | `ctx.read` and `ctx.write` (`jobs.ts`), through `store.ts` as handlers do |
| No transaction waits on the network | `work` is synchronous: a promise is refused and undone, and the store is closed when `work` returns |
| One run at a time, and once per install | the scheduler, within its process; the claim in `app_jobs`, across processes |
| GitHub's 10 requests a minute | the pace in `fetch.ts`, server-wide |
| No job runs in the trial start | `HEARTH_JOBS=off` from `deploy/hearth-deploy.sh`; a deploy test |
| Stand-in answers never on a real server | `loadConfig` refuses `HEARTH_FETCH_STANDINS` without `HEARTH_AUTH=dev` |
| Status with view, a run with edit, at most one asked-for run every 5 minutes | the two routes, through `resolveInstall`; `requestRun` |

### GitHub Trending (`hearth-stones/trending`)

`manifest.ts`, `server.ts`, `spam.ts` (the deny-list, imported by `server.ts` only), `widget.tsx`, `page.tsx`, `trending.test.ts`, `README.md`, `package.json`. It replaces the sketch in A4: the languages are the space's, because the job that fetches them sees the space's settings only, and each person keeps their own first range and whether to see descriptions.

```ts
// trending/manifest.ts
import { defineApp } from "@hearth/sdk";

export default defineApp({
  id: "trending",
  name: { en: "GitHub Trending", zh: "GitHub 热门" },
  description: {
    en: "New repositories on GitHub with the most stars, by day, week and month.",
    zh: "GitHub 上按天、周、月统计星标最多的新仓库。",
  },
  icon: "trending-up",
  color: "purple",
  widget: { size: "tall" },
  network: ["api.github.com"],
  settings: {
    languages: {
      type: "multi-select", scope: "space", default: [],
      label: { en: "Languages to follow", zh: "关注的语言" },
      help: { en: "Each language adds three searches to every hourly refresh.", zh: "每关注一种语言，每小时的刷新就多三次搜索。" },
      // Each key is GitHub's own name for the language in a `language:` qualifier.
      options: {
        typescript: { en: "TypeScript", zh: "TypeScript" }, javascript: { en: "JavaScript", zh: "JavaScript" },
        python: { en: "Python", zh: "Python" }, go: { en: "Go", zh: "Go" }, rust: { en: "Rust", zh: "Rust" },
        java: { en: "Java", zh: "Java" }, cpp: { en: "C++", zh: "C++" }, csharp: { en: "C#", zh: "C#" },
        swift: { en: "Swift", zh: "Swift" }, kotlin: { en: "Kotlin", zh: "Kotlin" },
      },
    },
    range: {
      type: "select", scope: "user", default: "week",
      label: { en: "Show first", zh: "默认显示" },
      options: { day: { en: "Today", zh: "今天" }, week: { en: "This week", zh: "本周" }, month: { en: "This month", zh: "本月" } },
    },
    hideDescriptions: {
      type: "switch", scope: "user", default: false,
      label: { en: "Hide descriptions", zh: "隐藏描述" },
    },
  },
  messages: { en: { /* the table below */ }, zh: { /* the table below */ } },
});
```

The widget and the page take the names of ranges and languages from the manifest's options, so each is written once, in both languages.

| Key | English | Chinese |
|---|---|---|
| `all` | All | 全部 |
| `range` | Range | 时间范围 |
| `language` | Language | 语言 |
| `updatedNow` | Updated just now | 刚刚更新 |
| `updatedMinutes` | Updated {minutes} min ago | {minutes} 分钟前更新 |
| `updatedAt` | Updated at {time} | 更新于 {time} |
| `refresh` | Refresh now | 立即刷新 |
| `refreshing` | Refreshing… | 正在刷新… |
| `failed` | Couldn't reach GitHub at {time}. | {time} 时无法连接 GitHub。 |
| `failedShowing` | Couldn't reach GitHub at {time}. Showing results from {previous}. | {time} 时无法连接 GitHub。现在显示的是 {previous} 的结果。 |
| `retry` | Try again | 重试 |
| `emptyFirst` | No results yet. The first refresh is on its way. | 还没有结果，第一次刷新马上就到。 |
| `emptySet` | No new repositories here yet. | 这里还没有新仓库。 |
| `stars` | {count} stars | {count} 星 |
| `forks` | {count} forks | {count} 个分叉 |
| `ageHours` | {count} h old | {count} 小时前创建 |
| `ageDays` | {count} d old | {count} 天前创建 |
| `newTab` | opens in a new tab | 在新标签页中打开 |
| `hide` | Hide | 隐藏 |
| `hid` | Hid {name}. | 已隐藏 {name}。 |
| `undo` | Undo | 撤销 |
| `hidden` | Hidden ({count}) | 已隐藏（{count}） |
| `show` | Show again | 重新显示 |

```ts
// trending/server.ts: the collections and the job
const RANGES = ["day", "week", "month"] as const;
type Range = (typeof RANGES)[number];
/** owner/name as GitHub allows them, so that a link built from one can only lead into github.com. */
const fullName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/);

const app = defineServer(manifest, {
  repos: z.object({
    range: z.enum(RANGES),
    set: z.string().max(20),            // "" for every language, else the key of a language the space follows
    position: z.number().int().min(0),  // GitHub's order within its set
    githubId: z.number().int(),
    fullName,
    description: z.string().max(350).default(""),
    language: z.string().max(60).default(""),   // as GitHub names it; "" when it names none
    stars: z.number().int().min(0),
    forks: z.number().int().min(0),
    repoCreatedAt: z.string().max(30),          // "createdAt" is a Row field's name
  }),
  hidden: z.object({ githubId: z.number().int(), fullName }),
});

// in app.routes({ ... }), beside the routes in the table below
refresh: app.job(
  {
    description:
      "Fetches from GitHub's search API the most-starred repositories created in the last day, week and month, for every language and each language the space follows, and replaces the stored lists with them.",
    everyMinutes: 60,
  },
  async (ctx) => {
    const sets: { range: Range; set: string; items: Repo[] }[] = [];
    for (const range of RANGES) {
      for (const set of ["", ...ctx.settings.languages]) {
        const answer = await ctx.fetch(searchUrl(range, set, ctx.now), { headers: GITHUB_HEADERS });
        if (answer.status === 403 || answer.status === 429) {
          throw new Error(`GitHub turned the search down (${answer.status}), most likely for its rate limit.`);
        }
        if (!answer.ok) throw new Error(`GitHub's search answered ${answer.status}.`);
        sets.push({ range, set, items: searchAnswer.parse(answer.json()).items.filter(keep) });
      }
    }
    // All or nothing, so that every list shown is from the time the job's status gives.
    ctx.write((db) => {
      db.repos.removeWhere({});
      for (const { range, set, items } of sets) {
        items.forEach((item, position) => db.repos.insert({ range, set, position, ...fromGitHub(item) }));
      }
    });
  },
),
```

| Route | Input | Does (each with its one-sentence `description`) |
|---|---|---|
| query `list` | `{ range, language? }`; `language` is "", every language, when left out | The rows of that range and set in GitHub's order (`orderBy: "position"`), without the hidden ones. |
| query `hidden` | none | The hidden repositories, the last hidden first. |
| mutation `hide` | `{ githubId, fullName }` | Puts the repository on the space's Hide list, once. |
| mutation `show` | `{ githubId }` | Takes it off the list. |

- **The searches.** A run asks 3 × (1 + the languages followed) of them, at most 33: for each range (day, week, month) every language first, then each language followed, in the options' order. `searchUrl` gives `https://api.github.com/search/repositories?q=...&sort=stars&order=desc&per_page=25` with `q` = `created:>=` (the run's start less 1, 7 or 30 days, in UTC to the second: `2026-11-04T14:05:07+00:00`) `fork:false archived:false forks:>=` (3, 10 or 25: a day gives a real project less time to be forked, and a month asks for less than four weeks' worth so that a late riser stays) and, for a language, `language:<key>`. `GITHUB_HEADERS` are `accept: application/vnd.github+json` and `x-github-api-version: 2022-11-28`.
- **Pacing** is `ctx.fetch`'s, 6.5 seconds a request across the server: 33 searches take under 4 of the run's 5 minutes. The app uses search alone; GitHub's other endpoints allow 60 unauthenticated requests an hour, which this pace would not keep to.
- **Rate limits.** A 403 or 429 stops the run at once (decision 12), and the backoff tries again 5 minutes later. Nothing is written before the end, so the lists stay as the last good run left them, and "Showing results from 13:05" is exact.
- **What is kept.** `searchAnswer` is a zod schema of the fields used (`id`, `full_name`, `description`, `language`, `stargazers_count`, `forks_count`, `created_at`), and `Repo` one of its items, so an answer of another shape fails the run. `keep` leaves out spam and a name GitHub could not have given (`fullName`); `fromGitHub` maps an item to a row's fields and cuts a description to 350 characters. Up to 25 a set, 825 rows at most.
- **Spam** (decision 10). After the query's `fork:false archived:false` and forks minimum, `isSpam` drops a repository whose name and description, with `-`, `_`, `.` and `/` read as spaces, match one of three patterns, one for each kind the owner named: a year and "installer" (`/\b(?:19|20)\d\d\b.*\binstaller\b/i`), crypto bots (`/\b(?:mint|sniper|drainer|volume) ?bot\b/i`) and fake balances (`/\b(?:fake ?balance|flash ?usdt)\b/i`). The README lists them; the tests hold each to a sample it catches and a near miss it keeps ("nix-installer", "mint-theme"). Last, the space's Hide list: `hide` and `show` need edit, `list` always leaves hidden repositories out, and a run never touches the list.
- **The widget** (tall): the reader's own range, every language, the first five: rank, owner/name as a link, stars. Under them "Updated N min ago", "Refreshing…", or `failed` in the colour of a problem; `emptyFirst` before the first results.
- **The page**, as decision 13: at the top "Updated N min ago" and, for edit, "Refresh now" (disabled, "Refreshing…", while `running`); when `failedAt` is set, the banner `failedShowing` (`failed` before any results) with "Try again" for edit; a `Segmented` control for the range, starting at the reader's own; `Chip`s for "All" and each language the space follows; then the rows: rank, owner/name, the description on one line unless the reader hides descriptions, language, stars, forks and age. For edit each row has "Hide", followed by "Hid owner/name. Undo", and "Hidden (n)" lists the hidden ones with "Show again". `emptySet` for a set with no rows. On a phone the rows wrap and nothing reaches past the screen's edge.
- **Links and pictures.** A link is `https://github.com/` and the stored name, with `target="_blank"`, `rel="noopener noreferrer"` and `newTab` for screen readers. There are no avatars: the Content-Security-Policy allows images from this server only, and stays so.
- **Times** are read against the browser's clock, in the reader's time zone and language (`Intl.DateTimeFormat`): "Updated just now" under a minute, minutes under 90, then "Updated at 13:05"; an age in hours under 48, then in days.
- **The `package.json` of `hearth-stones`** declares `"hearth": { "sdk": "^0.1.1" }` with this app, once C1 to C8 are on `main` of `hearth`.

### Left out on purpose

- A request rate declared for each host: every host gets GitHub's pace.
- Tokens and secrets (no `Authorization` header can be sent), methods other than GET, an HTTP proxy for outgoing requests, pinning the address a host resolves to.
- One cache for the spaces that have the same app: each install fetches for itself (decision 14).
- Jobs in parallel, a history beyond the last run of each outcome, and a list of every job's status for the server's owner.
- Push notifications and email (decision 11).

### Build plan for section C

Each step is one pull request into `main` of the repository it names; `pnpm check` passes at the end of each, and each updates `AGENTS.md` where a fact there changes. The SDK becomes 0.1.1 in C1; C2, C6 and C7 add to it without raising it again, since no repository declares 0.1.1 before C9, which needs all of them. A step that is built says so; the others are not built yet.

- **C1. The manifest's hosts** *Built.* (`hearth`). `network` in `Manifest` and in `manifestSchema`; the add dialog's line (`apps.addNetwork` in `en.ts` and `zh.ts`); the SDK's version 0.1.1.
  *Testable:* the schema takes `["api.github.com"]` and refuses a scheme, a port, a path, upper case, a wildcard, an IP address, `localhost`, `printer.local`, a name twice, an empty list and eleven names; the dialog names the hosts of a new app and of one brought back, in both languages (`manage.test.tsx`, with a made-up manifest).
  *As built, where it differs from "The manifest's hosts":*
  - **A label neither starts nor ends with a hyphen**, as in every DNS host name, which the design did not say. `home.arpa` itself is refused with the names that end in it; a name that only starts like a local one (`localhost.example.com`) is a name of the internet and is taken.
  - **The schema counts the hosts itself**, not with zod's `.min()` and `.max()`, which also measure a text given instead of a list and would add a misleading "at most 10" to the message that a list is wanted. It reports every problem at once, each at the host it is about (`network.2`); a name given twice is reported at its second place.
  - **The start-up check refuses a bad host** through `manifestSchema`, in `createRegistry` and so in `hearth-apps check` (`registry.test.ts`). Refusing hosts in an app that defines no job waits for C2, which brings jobs.
  - **The hosts are joined by `joinNames`** (`packages/web/src/i18n/index.ts`): ", " in English and "、" in Chinese. The separators are not in the dictionaries, because every string there must hold Chinese text (an i18n test) and "、" alone holds none. The line comes right under the description; for an app brought back, the note about its data follows it.
  - **The SDK is 0.1.1** (`packages/sdk/package.json` and `SDK_VERSION`). `hearth-stones` and `packages/fixture-apps` still declare `^0.1.0`, which 0.1.1 fits. A repository whose apps name `network` declares `^0.1.1`, which an SDK of 0.1.0 refuses with status 3.
- **C2. Jobs in the SDK, checked at start-up** *Built.* (`hearth`). `app.job`, `Job`, `JobAbout`, `JobCtx`, `FetchInit`, `FetchResponse`, `FetchError`, `SpaceSettingsOf` and `JobName`; `routes` takes jobs; `checkServer` and `createRegistry` check them; the new lint message for `fetch`. Nothing runs a job yet.
  *Testable:* type tests (a job's settings are the space's only, `read` gives no way to write, `JobName` lists jobs and `QueryName` and `MutationName` do not, a job without a description or an interval does not compile); the start-up check refuses an empty description, 14, 10081 and 60.5 minutes, an input, and hosts without a job; `/q/` and `/m/` answer 404 for a job's name.
  *As built, where it differs from "Jobs in the server file" and "`ctx.fetch`":*
  - **The types refuse a `work` that waits.** `ctx.read` and `ctx.write` take a `work` whose result may be anything but a promise, so an `async` work, or one that hands back a promise, is a type error that names the rule ("work must not be async: it runs inside one transaction"), as an async handler is. The run-time refusal in C4 stays: JavaScript that ignores the types still meets it.
  - **An `input` given to `app.job` past the types is kept** on the job, so that `checkServer` refuses it ("A job takes no input: it runs by itself, for no one.") instead of the job losing it without a word. The types refuse it anyway, as a property `JobAbout` does not have.
  - **What is wrong with a job is said as `server job "name"`**, and a refused `everyMinutes` is named with its value ("...from 15 to 10080 (a week); it is 60.5."), a missing one as "missing". The limits are `JOB_INTERVAL` in `definition.ts`; the SDK's comment on `everyMinutes` states them.
  - **Hosts without a job** are refused once the server file passed its own check, as `App "x": manifest network: Names hosts to fetch from, but the app has no job, and only a job fetches. ...`; an app without a server file counts as one without a job.
  - **`SpaceSettingsOf` of a manifest not known exactly** (the plain `Manifest`, whose settings may be of either scope) is a record of every setting value, as `SettingsOf` is; for an app's own manifest it holds the settings of scope "space" alone.
  - **`FetchError` is made with `(code, message)`**, as `AppError` is, and `FetchErrorCode` names its five codes.
  - **`/q/` and `/m/` already answered 404** for a route of another kind, which a job is; `callApp` now names jobs in that check, and a test asks both addresses for a job's name, as an owner and as a viewer, and finds that it never ran.
  - **`hearth-apps check` passes an app whose job fetches and then writes** (`tools/cli.test.ts`), so that the import scan, the types of a mini-apps repository, its lint and the start-up check all take a job as an app will write it; the same test fails one that runs every 14 minutes beside one that names hosts without a job.
- **C3. `ctx.fetch`** *Built.* (`hearth`). `fetch.ts`: the rules, the pace, Node's transport and the stand-in file; `HEARTH_FETCH_STANDINS` in `config.ts`.
  *Testable:* through a stand-in transport, and through Node's transport given a made-up `fetch` that returns real `Response` objects: every refusal; the headers sent (the User-Agent, the allowed ones, each refused name); redirects on and off the host; the timeout; the size cap stopping a download; the pace with a fake clock (6.5 seconds for one host, other hosts not held up); stand-ins matched, failing with `error`, and rewritten between two requests; `loadConfig` refusing the file without `HEARTH_AUTH=dev`.
  *As built, where it differs from "`ctx.fetch`" and "Switches":*
  - **Each request on the wire is paced and timed by itself.** The next request of a redirect waits for its host's turn like any other, so that no request breaks the pace, and each answer has its own 20 seconds, counted from when its request is sent, after its turn: the wait for a turn counts against the run alone (`fetch.test.ts` holds a request that waited 6.5 seconds and then took 15 to its answer).
  - **The rules refuse more than the design lists**, each before anything is sent: an address that is not text; a second argument with anything but `headers` (a `method`, a `body`, a `signal`), or that is not an object; headers that are not a plain object of names and values (a `Headers` object or a list of pairs); a name that is not an HTTP token; a header given twice in any mix of cases; and a value that is not visible ASCII, spaces and tabs, since a line break could start another header and a character past ASCII goes out as bytes a server may read two ways. A name that starts `x-forwarded` is refused with `x-forwarded-*`, dash or not.
  - **The pieces and their names.** `fetchFor(outbound, { hosts, signal })` is a run's `ctx.fetch`; its `signal` ends with the run. An `Outbound` is a transport, a pace (`createPace`, or null for stand-ins) and a `Clock` (milliseconds and timers: the process's own is monotonic, so that setting the system's time stretches no wait; a test's moves when told). `outboundFor(config)` makes the server's one: `nodeTransport()` with a pace, or `standInFile(path)` without. A `Transport` takes a checked request (address, headers, signal) and gives a WHATWG `Response`; it may reject with `FetchError` `timeout` or `network` to say why there is none, and any other rejection counts as `network`. `standInResponse` makes a stand-in's answer into a `Response`, for the file now and for a test's own function in C7.
  - **A transport, or a body, that does not listen to its signal is not waited for**: the time limit and the end of the run reject all the same, and an answer that still comes is cancelled unread. A body that breaks off is `network`; so is an answer that is not made of bytes.
  - **Node's transport** also passes `credentials: "omit"`. Node's fetch adds headers of its own that say nothing about anyone (`accept: */*` and `accept-language: *` unless the job gives its own, `accept-encoding`, `sec-fetch-mode`), and decompresses what it is sent, which the 2 MiB count after.
  - **The answer** leaves out `set-cookie2` as well as `set-cookie`, and is frozen. `json()` throws a `SyntaxError` that names the address. `stopped` before anything was sent says "The run is over: ctx.fetch works only while its job runs."; a message names the address without its query, user name or password.
  - **The stand-in file is checked as it is read**: a list of entries with the design's keys only (`url`, https without a query or fragment; `query`; `status`, 200 to 599, which is what a `Response` can carry; `headers` HTTP allows; `body`; `error`), never an `error` beside an answer, and no body for 204, 205 and 304. While the file is missing, is not JSON or is not such a list, every request fails as `network` with a message naming the file and the first problem, as a request no entry answers does with its address. A body that is not text gets `content-type: application/json` unless the entry names one. An entry may answer with a redirect, which the rules follow as any other. Since the file is read at every request, a test writes it whole, by renaming a new file into place.
  - **`main.ts` warns at start-up** that every `ctx.fetch` is answered from the stand-in file when `HEARTH_FETCH_STANDINS` is on, already in this step, and the server's README names the setting; C5 adds `HEARTH_JOBS` beside it, and the outgoing connections in `docs/self-hosting.md`.
  - **The SDK's comments** on `FetchInit` and `JobCtx.fetch` now state these rules, so that an app's author meets them in the editor; its types are unchanged, and it stays 0.1.1.
  - **Nothing calls it yet.** The run (C4) gives a job `ctx.fetch` with `fetchFor`, and the scheduler (C5) has `main.ts` make the server's `Outbound` with `outboundFor`.
- **C4. Running a job** *Built.* (`hearth`). Migration 3; `jobs.ts` (`claimRun`, the run with its `ctx` and time limit, `recordRun`, `requestRun`, `jobStatus`); `spaceSettingsFor`; a job's author and `mine` in `store.ts`.
  *Testable:* the migration on a version-2 database with data, and the guards of `apps-schema.test.ts`; a job writes in its own space and app only (A6's two-space test, for a job); after a removal, a move, a deletion or a claim taken over, `write` throws and nothing is kept; a `work` that returns a promise is undone and fails the run; `ctx` stops working when the run ends; a run that never ends is stopped at 5 minutes; the times, the error cut to 200 characters, the backoff and the jitter's bounds; one claim at a time, and a stale one taken over; `requestRun`'s 5 minutes, and nothing changed during a run.
  *As built, where it differs from "Jobs in the server file", "Running a job" and "Table":*
  - **The pieces and their names.** `claimRun` gives a `Claim` (the run's ID, its start, the job's interval, the space's kind and name, its settings) or why it took none: `"absent"`, `"running"` or `"not_due"`. The run is `runClaimed`, which resolves with how the run ended: `succeeded`, `failed` (with the message and what was thrown), `stopped` (the server stopped it) or `gone` (see below). `recordRun` records that and says whether it found the claim. `runOnce` does the three in order, for the scheduler (C5) and for `testApp`'s `runJob` (C7) with `force`, so that each goes through the same code. What a run needs from around it is given (`RunWorld`: the way out for `ctx.fetch`, a `Clock` for the time limit, the time of day, the randomness for the jitter and a signal for the server stopping), so that its tests neither wait nor reach a network; their fake clock (`src/apps/test-clock.ts`) is the one `fetch.test.ts` had, moved out to be shared.
  - **A run ends at once**, not only when its function settles: when its 5 minutes are up, when the server stops it, when `ctx.read` or `ctx.write` is refused for the install, and when work handed them a promise. The function is not waited for after that, `ctx.fetch` rejects with `stopped` (a request on its way included), `ctx.read` and `ctx.write` throw "The run is over: ctx.read and ctx.write work only while its job runs.", and the first reason is what is recorded, whatever the function does next.
  - **A run that reaches its time limit failed**: "The run took longer than 5 minutes, so it was stopped." is recorded, with the backoff. Only a run the server stopped, and one refused for its install, count for nothing. The limit is also checked by the time of day inside the transaction of `ctx.read` and `ctx.write`, since the timer of a busy process may fire late.
  - **"Gone" is a refusal, not a move.** A run is recorded as nothing, its job due at once wherever its row now is, when `ctx.read` or `ctx.write` was refused because the app was removed, left the space (moved, or its data deleted) or another run had taken the job over. A run that did not reach for its rows after such a change ends as its function does, and is recorded on the job's row wherever it went: a run that wrote before a move wrote rows that moved with it. Each refusal says which it was, in a `RunRefusedError`: "The app was removed from this space during the run.", "The app left this space during the run: it was moved to another, or its data was deleted.", "Another run has taken this job over: ...", each ending "Nothing was read or written."
  - **Work handed a promise ends the run as failed** even when the job catches the error: the store's `StoreUsageError` names the app, the job and the rule. Work that is not a function, and `ctx.read` or `ctx.write` called inside the work of either, are refused with a `StoreUsageError` too; those the job may catch and go on.
  - **A job's store** is `readOnlyStore` or `writableStore` with a scope that names the job (`StoreScope.job`, null for a handler's). Its `userId`, recorded on what it writes, is the person who added the app (`space_apps.created_by`, read in the check before the work), and the time is that of the write; `list({ mine: true })` and a store kept past its work are refused with messages that name the job. `ctx.settings` comes from `spaceSettingsFor`, which fills the space's settings alone (`readSpaceSettingsData`) with the routes' own `fill`.
  - **What is recorded of an error** is its message on one line (white space run together), cut to 200 characters with "…" as the last of them; characters as SQLite counts them, so a character beyond the basic plane is never cut in half. An `Error` without a message is recorded as its name ("TypeError, with no message."), and a thrown value that is not an `Error` as what it was.
  - **The jitter** takes the randomness given, kept to 0 to 1, and times are stored to the millisecond, rounded down. A claim leaves `next_run_at` as it was, so during a run the status shows when that run was due.
  - **`requestRun` and `jobStatus` hold the routes' checks** (C6 adds the routes): 404 when `resolveInstall` gives null, the app has no server file or no job of that name, then 403 for a run asked for with view, as `readAppSettings` and `changeAppSettings` do for theirs. Both take the time as an argument for their tests. Their answer is `JobStatus` in `jobs.ts`, of the shape of `jobStatusSchema`, which C6 puts in `@hearth/shared`. The five seconds `HEARTH_FETCH_STANDINS` allows between runs is not built: the gap is `REQUEST_GAP_MS`, and the route that knows the server's settings passes another when that comes.
  - **Migration 3 is tested with every table of migration 2 holding rows**, a removed app among them, and its tests name the migrations they apply, so that a later migration leaves them as they are. `app_jobs` is `ON DELETE CASCADE`, unlike `app_rows` and `app_settings`: it is status, not data.
- **C5. The scheduler and its switches** *Built.* (`hearth`). `scheduler.ts`; `HEARTH_JOBS`; `main.ts` starts it once listening and stops it before closing the database; `HEARTH_JOBS=off` for the trial start, with its deploy test; every e2e command that starts a server sets `HEARTH_JOBS=off`. The server's README and `docs/self-hosting.md` name the two settings and the outgoing connections.
  *Testable:* with a fake clock and a stand-in transport: one run at a time, the earliest due first, a new install at once, the idle wait and the wake, a second scheduler on the same database (a restart) going on where the first stopped, a stop that aborts a run and leaves the job due, two schedulers on one database file running each job once; the settings; the deploy case.
  *As built, where it differs from "The scheduler" and "Switches":*
  - **The pieces and their names.** `createScheduler` (`scheduler.ts`) makes a scheduler with `start`, `wake` and `stop`, given the database, the registry, the server's `Outbound`, a `Clock`, the time of day, the randomness and a `log`. Which job is next is `nextJob` in `jobs.ts`, so that the SQL of `app_jobs` stays in one file: its one query reads `space_apps` and `app_jobs`, and the jobs come from the registry. Each job it finds due goes through `runOnce`, as `testApp` will.
  - **When a job is due**, for `nextJob`: at once when it has no row (never run in the install); at its `next_run_at` otherwise; and while a run holds it, when that claim runs out, or at its `next_run_at` if that is later (a run forced before its time holds a job that `claimRun` would not take when the claim runs out). So a job another process is running is not asked for until then, and each sleep is still at most 30 seconds.
  - **The wake** is `wakeJobs`, an option of `createApp`, which `main.ts` fills with the scheduler's `wake` and which is a no-op otherwise. The route that adds an app calls it when the app was added or brought back, not when it was already there or the request was turned down. The route that asks for a run (C6) calls it too.
  - **A claim refused** between looking and claiming (another process claimed the job or ran it, or its install went away) makes the scheduler look again at once; the same job refused twice in a row makes it sleep, so that a disagreement between the two can never spin.
  - **A look that fails** (the database cannot be read or written) is logged as one line, "The scheduler could not run jobs (...). It looks again in 30 seconds.", and the scheduler goes on 30 seconds later instead of stopping for good; a claim it left behind is taken over when it runs out. Between one run and the next it lets the process answer requests (`setImmediate`), however quick the runs.
  - **The log line** of a run that went wrong is `App "trending", job "refresh", space <ID>: the run failed: <message>`, the message on one line and cut at 1,000 characters, more than the 200 kept in `last_error`. A run that went well, one the server stopped and one refused for its install leave no line.
  - **Stopping in `main.ts`.** On SIGTERM or SIGINT the scheduler stops (no new run; the one going on ends at once, recorded as stopped, its job due at once) while the server stops listening; once both are done the database is closed and the process exits. Whatever holds that up, after 5 seconds the database is closed and the process exits all the same; before, that timer exited without closing it. Tried by hand on a built server with a job that never ends: it exits within 15 milliseconds, its database closed, and the job runs at once at the next start.
  - **`HEARTH_JOBS`** takes `on` or `off` and no other spelling, from the environment or the config file (`jobs` in `Config`); `main.ts` says at start-up when jobs are off. The made-up server of the deploy tests writes `trial off` and `live unset` into a file beside it, `started-with`, and the case after the first release reads it. In `e2e`, `realServerCommand` gives `HEARTH_JOBS=off` to every copy of the server both Playwright configurations start; C8 gives stand-ins where a test needs jobs.
  - **The outgoing connections** in `docs/self-hosting.md` are all of the server's: Cloudflare Access's signing keys, the hosts its apps' jobs name, and for the deploy script the repositories and the npm registry. A deploy script installed before this step starts the trial without `HEARTH_JOBS=off`: the guide says to install the new one, as the journal asks after the first switch, before mini-apps with jobs arrive.
- **C6. Routes, `useJob` and the shell** *Built.* (`hearth`). The two routes and `jobStatusSchema`; `useJob` in `appHooks`, `AppScopeValue` and `<AppScope>`; `api.ts`.
  *Testable:* the routes' answers in their order (404 for an app hidden from the caller, a job that is not there and a query's name; 403 for a run with view; 202 with the status), and the debounce through the route; the hooks' types and hand-over (`hooks.test.tsx`); `<AppScope>` against a stand-in server (`app-view.test.tsx`): it suspends, reads the status every 3 seconds while `running`, reads the queries again when `succeededAt` changes, and reports a refused `run()`.
  *As built, where it differs from "Routes" and "Hooks":*
  - **The answer's shape is `@hearth/shared`'s alone.** `jobStatusSchema`, its type `JobStatus` and `JOB_STATES` are there, and `jobs.ts` answers with that type instead of one of its own. The routes are in `routes.ts` beside the others (`job-routes.test.ts`): the `GET` answers 200, the `POST` 202, and a body sent with the `POST` is not read, as for the `DELETE` that removes an app.
  - **The five seconds of `HEARTH_FETCH_STANDINS` are built here.** `requestRun` takes the gap as an argument; `requestGapFor(config)` in `jobs.ts` gives 5 minutes (`REQUEST_GAP_MS`), or 5 seconds (`STAND_IN_REQUEST_GAP_MS`) when stand-ins answer every fetch, and `createApp` hands it to the routes, as `outboundFor` picks the way out from the same setting.
  - **The run route wakes the scheduler when a run was asked for** (the answer's `state` is `requested`): not during a run, when asking changes nothing, and not when the request is turned down.
  - **What a status means to a widget is one function**, `jobStateOf` in `@hearth/shared`: `succeededAt`, `failedAt` (only when the last run to end went wrong, compared as times) and `running` (`running` or `requested`), so that the web app and, from C7, an app's own tests read a status alike.
  - **New data comes before the new status.** When a status that has just come (a reading, or the answer of `run()`) names a later run that went well than the cached one, `<AppScope>` reads every query of the app here again and waits for them before it caches and shows that status, so a widget never says "Updated just now" beside the old list. A re-read that fails leaves the queries as they were, for their next turn.
  - **`run()` shows the `POST`'s answer** instead of reading the status again: it calls off a reading of the status on its way, which was sent before the request and would put the job back as it was, then caches the answer. It resolves once that is shown, so `running` is true when it resolves; `pending` is true until then.
  - **A refused `run()` is handled as a refused mutation, by the same code** (`afterFailedChange` in `scope.tsx`): the shell's notice under the app, the app here read again, and for `not_found` the session first, the app read again only while the session still lists it.
  - **"While `running`" includes a run asked for that has not started**, as `JobState.running` does: the status is read every 3 seconds also while such a run waits for the end of its 5 minutes, and, on a server with `HEARTH_JOBS=off`, for as long as the page is open and visible. A hidden window reads nothing, as for queries.
  - **`JobState` is in the SDK's `src/routes.ts`**, exported from `@hearth/sdk/web` with the other hooks' types and from `@hearth/sdk/web/scope` beside `AppScopeValue`, so that the types of C7 can share it. The SDK stays 0.1.1.
- **C7. Jobs in an app's own tests** *Built.* (`hearth`). `runJob` on `TestApp`, `job` and `requestRun` on a caller, and their types in `@hearth/sdk/testing`.
  *Testable:* `app-testing.test.ts`: a run through the scheduler's functions (the stand-in sees the User-Agent; an undeclared host, a refused header or a promise from `write` fails the run, as on the server), the status a viewer sees after a run that went well and after one that did not, and `requestRun` forbidden with view and debounced with edit; `testing.test.ts` for the types.
  *As built, where it differs from "Testing":*
  - **`fetch` may be left out, and so may the options.** `runJob(name, options?)` takes `RunJobOptions`, `{ fetch?, now? }`. Without a stand-in every request fails as the network would ("No stand-in answers ...: runJob was given no fetch."), so a job that fetches nothing, one that tidies the app's rows, say, runs without one. The design had `fetch` required.
  - **The pieces and their names.** `StandInRequest`, `StandInAnswer`, `StandInFetch` and `JobRun` are as designed, and `job` and `requestRun` give `Omit<JobState, "run" | "pending">`; the handles of `@hearth/sdk/testing/host` gain the three, untyped. In the framework, `createTestApp` (app-testing.ts) runs a job with `runOnce` and `force`, its way out a transport made from the test's function (`standInTransport`) with no pace, the process's clock for the run's 5 minutes and each answer's 20 seconds, and `Math.random` for the jitter, as on a server. `job` and `requestRun` go through `jobStatus` and `requestRun` with a server's gap of 5 minutes (`REQUEST_GAP_MS`); `canRun` is edit by `resolveInstall`, as the session's `access` is for `useJob`.
  - **What a run gives back.** `error` is the whole message of what made the run fail, on one line, as `runOnce` gives it, not cut to the 200 characters kept in `last_error` or the 1,000 of the scheduler's log line. A test's `job` hands over no message, as `useJob` hands over none.
  - **A test's mistakes reject, a job's failures resolve.** `runJob` rejects, and the test fails, for a name that is not one of the app's jobs, options other than `fetch` and a valid `now`, a run of the same job going on in the same world (kept in memory, so that no run is claimed beside another whatever times a test gives), a personal space whose one person was not yet named with `as(...)`, which is when the app is added there, and a stand-in's answer that HTTP could not carry. That answer is held to the rules of an entry of the stand-in file by the same schema (`standInAnswerProblem` in fetch.ts, which `standInFile` shares): an object of `status` (200 to 599), `headers` HTTP allows and `body` alone, no body with 204, 205 and 304, and a body that is text or that JSON can hold, which the file's always is. The job sees such a request fail as the network would, and `runJob` rejects with the mistake once the run is recorded.
  - **A stand-in that throws** fails the request as the network would, with its message; a `FetchError` of code `timeout` or `network` that it throws is passed on as itself, as the stand-in file's errors are, so that a test tries a timeout without waiting 20 seconds.
  - **A status during a run.** `job` and `requestRun` read the job at the time of day, but while a run of it is going on in the world, at the moment the test gave that run, which is also when it ends: a run given a time long past still holds its job (`running`), and a run asked for meanwhile changes nothing, as on a server.
  - **The framework's own tests give a world its parts.** `createTestApp` takes a third argument, `TestWorldParts` (`db`, `now`, `clock`), which `testApp` never passes: `app-testing.test.ts` gives a database to read `app_jobs` from, a time of day it moves, and `fakeClock`, so that the debounce, the 5 minutes, the 20 seconds and the absence of a pace are tested without waiting.
  - **`hearth-apps check` runs an app's own test of its job** (`tools/cli.test.ts`): the made-up `headlines` app has a test that runs its refresh with a stand-in, reads its status as a viewer and asks for a run, in a repository linked to the SDK, so that the types, the lint, the import scan and the hand-over hold as an app will use them. The SDK stays 0.1.1.
- **C8. A sample app with a job, end to end** (`hearth`). `packages/fixture-apps/headlines`: a manifest naming `feeds.example.com`, a job that keeps the latest headlines, a widget with "Updated N min ago", "Refresh now" and the failed state, and tests of its own; `FIXTURE_APPS`; in `pnpm e2e` the owner's and Lin's copies share one stand-in file; the stand-in of `e2e/fixtures.ts` answers the job routes; `docs/architecture.md` and the SDK's README describe jobs.
  *Testable:* its own tests; on the built server, the add dialog names the host, the first run happens at once and the widget shows the headlines and "Updated just now"; with the stand-in failing, "Refresh now" keeps the old headlines and shows the failure; Lin, who may only view, has no button; Chinese and a phone; no script error and nothing the Content-Security-Policy refused.
- **C9. GitHub Trending: data, job and widget** (`hearth-stones`, built and checked against the `hearth` checkout beside it; its CI there passes once C1 to C8 are on `main` of `hearth`, so `hearth` is merged first). The manifest, `server.ts`, `spam.ts`, the widget, the README and the tests; `"hearth": { "sdk": "^0.1.1" }`.
  *Testable:* `trending.test.ts`, with stand-ins: the searches a run asks for, in order, with their query and headers; what is stored, in GitHub's order and without the deny-list's matches (each pattern, and its near miss kept); a 403, a 429, a 500 and an answer of another shape each fail the run and keep the lists and `succeededAt`; the Hide list for edit and not view, applied by `list` and kept over a run; the space's languages decide the next run; a personal space. `pnpm check` there; Hearth built with it and run by hand against stand-ins.
- **C10. GitHub Trending: the page** (`hearth-stones`). The approved look (decision 13).
  *Testable:* `pnpm check`; looked at by hand against stand-ins on a desktop and a phone, light and dark, in both languages.
- **C11. GitHub Trending end to end** (`hearth`, built and run against the `hearth-stones` checkout beside it; in CI the file runs once C10 is on `main` of `hearth-stones`, as for any app's end-to-end file). `e2e/mini-apps/trending.spec.ts`; one stand-in file for both copies in `playwright.mini-apps.config.ts`.
  *Testable:* the owner creates a group, adds the app for everyone to view (the dialog names api.github.com) and follows Rust. With no stand-in yet the first run fails: the empty state and `failed`. With stand-ins, "Try again" brings the lists: ranks, links that open github.com in a new tab, the three ranges, the Rust chip, no spam; with the browser's clock 12 minutes on, "Updated 12 min ago". The owner hides a repository, undoes it and hides it again. Lin, on a phone in Chinese, sees the same lists without it and without buttons, and hides descriptions for herself alone. The stand-in answers 403, the owner asks for a refresh, and both see the banner with both times, only the owner with "Try again".

---

## D. Decisions for the owner

1. **When an app is added to the family space, who gets it?**
   Recommendation: the add dialog asks "only me for now / everyone can view / everyone can edit", with "only me" preselected. Everyone who has access sees it switched on straight away and can switch it off for themselves. New family members get whatever level was chosen for each app.
   Trade-off: safe by default at the cost of one extra click for a grocery list. Preselecting "everyone can edit" is friendlier but will one day expose a finance app by accident.

2. **When an app is removed from a space, is its data deleted?**
   Recommendation: no. Removal hides the app and keeps the data; adding it again brings everything back; deleting the data is a separate owner action with a typed confirmation.
   Trade-off: a mis-click costs nothing, but old data lingers until someone deletes it, and the settings screen needs a short "removed apps" list.

3. **Who may move a shared app, and what do the others see afterwards?**
   Recommendation: only the group's owner may move an app out of the group, and it goes into their own personal space, so everyone else loses it. Moving a personal app into the group needs the right to add apps there, and it arrives visible only to the mover and the owner until access is chosen (the same question as in 1).
   Trade-off: a move never exposes data by surprise, but the owner can take the family's list away with one action. The alternative is to forbid moving out while other members have access.

4. **Who may create groups and let new people onto the server?**
   Recommendation: for now only you, the server owner. Group owners can add people who are already on the server. The data model allows several groups and other group owners later.
   Trade-off: simple and safe for one family. If a family member later wants their own team space with outside people, they have to ask you.

5. **May a member with "edit" change an app's shared settings, such as the grocery aisles, or only the owner?**
   Recommendation: edit includes shared settings. Each person's own settings (for example their trending filters) are always theirs to change, even with view access.
   Trade-off: one fewer permission level to explain, but a child with edit access can rearrange the aisles for everyone. An owner-only rule would need a third level or a per-setting flag.

---

## E. Risks, and what was left out on purpose

**Risks**
- **I did not run the build mechanics.** The registry files, `link:`, `dedupe`, `@source` and `noExternal` behaviour rest on Design 3's scratch replica. Step 7 is where they are proven in this repository.
- **JSON rows in one table.** There are no sums, joins, uniqueness constraints or indexed filters beyond the scope. This is fine for lists of hundreds to a few thousand rows; switch to real tables when an app needs aggregates over roughly ten thousand rows (finance, stock history). All three designers named this as their least sure point.
- **No data upgrades.** A schema change that old rows do not satisfy breaks that app's queries until fixed. The rule "new fields get a default" is a convention the check cannot fully prove.
- **Zero third-party packages for mini-apps.** The first app needing a chart or Markdown library forces either growing the SDK or making `hearth-stones` a real workspace with a second networked install in the deploy.
- **Not a sandbox.** Mini-apps are trusted code. The import scan stops accidents; a determined author can still reach `fetch` or `process` at run time. Because the server deploys `main` within a minute, `hearth-stones` should require a passing check and review before merge.
- **SDK version discipline is manual.** The cross-repository CI job catches a break only after it lands on `hearth` main (as built in step 12, it also runs on every pull request, against `main` of `hearth-stones` at that moment). Tailwind token names are part of the SDK surface.
- **The `link:` handshake hard-codes the sibling folder name `hearth`.** Git worktrees and other layouts break it.
- **Polling, last write wins.** Changes appear within 15 seconds; two edits to the same field of one item resolve to the later one, silently.
- **Stale browser shell.** The service worker can serve an older web app against a newer server; the "Reload to update" card covers an unknown app but not an SDK behaviour change.
- **GitHub trending is blocked on the scheduler.** Where fetched public data lives is that step's decision: once per space fits the "every row has a space" rule as written, while one shared cache per server avoids duplicate fetches but needs that rule clarified. Section C decides: each install's own rows, written by its own job (owner's decision 14).
- **A job reaches the internet.** It can send what it likes, its app's rows included, to the hosts its manifest lists. The add dialog names those hosts; mini-apps are trusted code, and review before merging is the guard.
- **"Deleting the folder removes the app" is true for code only.** Data stays hidden until the owner deletes it; the `hearth-stones` AGENTS.md wording should say so.
- **The deploy script is still untested on a real server**, and now also installs in a second folder.

**Left out on purpose**
- The scheduler, cached fetches and an outbound host list. Section C designs the scheduler and the host list; a cache shared by spaces stays out.
- Global search contributions, several pages per app, file storage and Markdown export. Reserved: the builder names `search`, `files`, `exporter` and `upgrades` (`job` is designed in section C), and the `/*` page route.
- A JSON export before deleting data.
- Asynchronous request handlers ("refresh now"). Section C's "Refresh now" asks the scheduler for a run instead.
- Push updates, optimistic updates and offline use.
- Per-row permissions and private rows inside a group space.
- Row revisions, tombstones and conflict detection; pagination and full-text queries in the store.
- Localized seed defaults for settings; a secret setting type.
- An audit log of add, move and access changes.
- Merging on move; renaming an app ID; deleting a space or a user.
- A multi-group interface (the tables allow it).
- Dashboard ordering and drag-and-drop.
- An API snapshot test for the SDK.
- Runtime plugin loading, a marketplace and a sandbox.
