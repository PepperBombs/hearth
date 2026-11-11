# The mini-app contract

This is the design the framework is being built to. It was agreed with the
owner before any of it was written, and it changes only by agreement. Parts
that are not built yet are marked in section B.

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
   - **`@hearth/sdk/testing` and `testApp(server)` are not built** (step 13). The framework's own tests call the routes over HTTP.
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
   - **The command is plain JavaScript**, so that it runs before anything is built: `bin/hearth-apps.mjs` reads the command line and `packages/sdk/tools` does the work (`sync.mjs`, `import-scan.mjs`, `check.mjs`, `eslint-boundary.mjs`). The type check covers it through its JSDoc comments. `dev`, `test` and `new` end with status 2 and say that they are not built.
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
   - **`check`** runs sync, then four stages, all of them even when one fails: `README.md` and `package.json` in every app; manifests and server files, by running `createRegistry` on the generated list (`packages/server/src/apps/check-bundle.ts`, started with `tsx`), which is the server's own start-up check; the compiler; ESLint on the app folders. **It does not run tests**: `hearth-apps test` and `@hearth/sdk/testing` are step 13. When an app has test files, it says that they were not run. Because it runs sync, it also writes the three generated files, for the folder it checked.
   - **`--out <folder>`** sends the generated files somewhere else. The tests use it so that they never change what this checkout builds.
   - **The server's configuration** has no `appsDir`. A JSON config file may still name `HEARTH_APPS_DIR`: it is ignored, so that a file written for an earlier release does not fail the trial start.
   - **The web app holds the list and draws nothing from it.** `main.tsx` gives it to `BundledAppsProvider` (`packages/web/src/apps/bundled.tsx`); step 8 reads it. Each widget is a file of its own in the build, fetched when first asked for.
   - **The fixtures.** `packages/fixture-apps` declares `hearth.sdk`, and its `tsconfig.json` extends the SDK's. `checklist` gained `package.json`, `README.md` and `widget.tsx`; `feed` has a manifest with two settings of each person's own, a widget and no server file. Both widgets are placeholders that draw the app's icon: a widget has no way to get strings, settings or data until step 8.
   - **The end-to-end tests build with the fixtures** (A7 lists that under CI): `playwright.config.ts` runs `pnpm apps:sync` with `HEARTH_APPS_DIR=packages/fixture-apps` before each build, so the workflow file did not change. After `pnpm e2e` both `dist` folders hold the sample apps until the next `pnpm build`.
   - **The deploy script is unchanged** (step 12). It does not pass `HEARTH_APPS_DIR`, so a deployed release still holds no mini-apps. The line is gone from `deploy/hearth.env.example`.
   - **Proven here, as section D asked:** an apps folder outside the checkout, linked to the SDK, passes `check` (a unit test) and builds (`link:`-style symlink, `dedupe`, `@source`, `noExternal`; tried by hand with `pnpm build`, the built server and `pnpm dev`, and the same mechanics are under test with `packages/fixture-apps`, which has no React of its own either). The build fails without `resolve.dedupe`. `pnpm install` in such a folder and the deploy's `--offline` install were not tried: `hearth-stones` has no `package.json` until step 13.
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
    - **A mover who is not an owner of the target gets an `edit` exception there**, as when they add an app (A6 "Access"). A6's step 1 deletes every exception, so without this a member who may add apps would move her own app into a group and lose it; section C3 says it arrives "visible only to the mover and the owner until access is chosen". The exception is written after the `UPDATE`, and is the one access row a move leaves.
    - **Any space the caller owns or may add apps to**, as A6 says. Decision 3 names the case of a group's owner moving an app into their own personal space; the same rule also lets them move it into another group, and anyone move an app out of their own personal space into a group where they may add apps.
    - **What goes and what stays.** The rows with their authors and times, the settings the space shares, and the own settings, switch and pin of everyone who is in both spaces go along. Those of everyone else are deleted first (A6 step 2); the SQL for their settings is `deleteOwnSettingsOfOthers` in `store.ts`, the one file for `app_settings`. `space_apps.created_by` and `created_at` stay, so the app keeps its place among the apps of its new space by when it was first added. `memberAccess` is stored as given for a personal space too, as adding does; nobody else is in one.
    - **The guard.** The `sqlite_master` test that step 3 put in `packages/server/src/db/apps-schema.test.ts` still checks the cascading key, and gained a second check: the tables with `space_id`, `app_id` and `user_id` are exactly the three `moveApp` clears of people who are not in the target, so a new one fails a test until the move deals with it (the database would refuse every move of that app out of a group).
    - **The dialog** is on the Apps page (`packages/web/src/pages/apps.tsx`). "Move", beside "Remove", shows on a row for an owner of the space when the session shows somewhere to go: another space where the person may add apps (`canAddApps`), whose kind the manifest this build holds allows, and which does not list the app (`useMoveTargets` in `packages/web/src/apps/manage.tsx`). It offers those spaces in the session's order, the personal one first, and the first is chosen; for a group it asks who else may use the app, "only me for now" first, as adding does (owner's decision 1); it says that everything goes along and, from a group, that people who are not in the new space lose the app and their own settings for it. The server decides again: a space that holds the app hidden from the person, or kept its data from before, turns the move down and the dialog says so, with the session loaded again. After a move the session and the owners' lists of both spaces are loaded again, the row leaves its card with its dialog, and the card of the space the app went to says "Checklist was moved here." and takes the focus.
    - **Still not offered in the interface** (step 10): deleting the data of a removed app. A space that kept an app's data cannot take that app by a move until the data is deleted through its route (`DELETE .../data`), which the end-to-end test on the real server does.
    - **Tests.** `packages/server/src/apps/move.test.ts` (the Testable line first, then who may move what where, every refusal and its order, and what follows a move: adding the app again where it left, moving it back, an app without rows or a server file) and the second guard in `apps-schema.test.ts`; `packages/web/src/apps/manage.test.tsx` (the dialog both ways, where it is offered, a refusal, Chinese); `e2e/apps.spec.ts` against the stand-in (out of a group and back with the owners' table following, a refusal, Chinese, a phone); and in `e2e/real-server.spec.ts` two people on the built server: the owner's own space first answers 409 while it has the checklist and while it keeps its data; then the owner moves the group's checklist, with an item from each of them, the group's sections and both people's own setting and pin, into their own space on the Apps page and back for everyone to view. In between Lin has no access at either address; afterwards she can view the data again, her own pin and setting are gone, her old edit access did not come back, and the owner's pin and setting made both trips.
12. **Deploy and CI.** *Built.* Change the deploy script as in A7 and add a handshake-failure case to `deploy/tests/deploy.test.sh`. Add the cross-repository CI job. Update `AGENTS.md`, `docs/architecture.md`, `docs/self-hosting.md` and the server README.
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
    - **The CI job** (`mini-apps` in `.github/workflows/ci.yml`) checks out this commit as `hearth` and `main` of `hearth-stones` beside it, from the same owner (`github.repository_owner`, so that no account name is written down). It installs, links the mini-apps offline when `hearth-stones` has a `package.json`, runs `hearth-apps check` on them (`HEARTH_APPS_DIR=../hearth-stones`) and then `pnpm build`. A7 says "builds"; the check comes first because a build does not check types, and a break of the SDK is most often one of its types. Status 3 passes with a notice and skips the build; any other failure fails the job. It runs on every pull request and every push to `main`, like the other jobs, so a break shows on its pull request before it lands, earlier than section D expected. It has not run on GitHub yet: a push to this branch starts no workflow.
13. **`hearth-stones` bootstrap.** Add the root `package.json`, tsconfig, ESLint config and CI; add `@hearth/sdk/testing` and `hearth-apps dev` and `test`; fill in the AGENTS.md "Layout and commands" section.
    *Testable:* `pnpm check` passes there with zero apps; CI is green.
14. **Template and scaffold** (build-order step 3): `hearth-apps new <id>` copies `checklist`.
    *Testable:* a scaffolded app passes `check` untouched.
15. **Grocery list** (build-order step 4).
    *Testable:* app tests with `testApp`; e2e of two family members sharing a list.

---

## C. Decisions for the owner

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

## D. Risks, and what was left out on purpose

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
- **GitHub trending is blocked on the scheduler.** Where fetched public data lives is that step's decision: once per space fits the "every row has a space" rule as written, while one shared cache per server avoids duplicate fetches but needs that rule clarified.
- **"Deleting the folder removes the app" is true for code only.** Data stays hidden until the owner deletes it; the `hearth-stones` AGENTS.md wording should say so.
- **The deploy script is still untested on a real server**, and now also installs in a second folder.

**Left out on purpose**
- The scheduler, cached fetches and an outbound host list.
- Global search contributions, several pages per app, file storage and Markdown export. Reserved: the builder names `job`, `search`, `files`, `exporter`, `upgrades`, and the `/*` page route.
- A JSON export before deleting data.
- Asynchronous request handlers ("refresh now").
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
