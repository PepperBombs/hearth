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

1. **SDK package skeleton.** *Built.* Add `packages/sdk` with `defineApp`, manifest types, the zod manifest schema, icon and colour unions moved from `app-icon.tsx`, and `SDK_VERSION`.
   *Testable:* type tests for message keys, placeholders and `SettingsOf`; the schema rejects a missing language, an unknown icon and a bad ID.
   *As built, where it differs from A1 and A2:*
   - The schema is `manifestSchema` in `@hearth/sdk/manifest-schema`, an entry point for the framework that mini-apps do not import. `@hearth/sdk` itself imports nothing, so a manifest does not pull zod into a widget's bundle.
   - `default` of a `multi-select` or `list` setting is typed `readonly string[]`, as `spaces` already is, so that a list declared `as const` is accepted too. `SettingsOf` still gives `string[]`.
   - The message types are `MessageKey<A>`, `PlaceholderArgs<A, K>` and `Translate<A>` (the type of `t`). They take a manifest today; `typeof server` joins in step 5.
   - The schema also checks what A7 lists under `hearth-apps check` for a single manifest: no empty text, defaults that fit their setting, the same placeholders in both languages. It refuses unknown properties, and a setting's name must be a plain identifier.
   - `step` of a `number` setting is not applied to its default: A2 does not say whether it limits values or only sets the form's increment. Step 6 decides.
2. **UI kit into the SDK.** *Built.* Move `components/ui` to `@hearth/sdk/web`, add `Checkbox` and `Icon`, add the `@source` line; the shell imports from the SDK.
   *Testable:* existing UI tests, contrast test and screenshot e2e unchanged.
   *As built, where it differs from A1, A4 and A7:*
   - `@hearth/sdk/web` exports the components A4 lists, and two helpers that already existed beside them: `buttonClass` and `chipClass`, the look of a button or chip as a class string, for links. The shell uses them, and a widget will want one for the link to its page.
   - `Card`, `CardHeader`, `CardFooter` and `Avatar` were in `components/ui` but are not in A4's list. They stay in the shell (`packages/web/src/components`), since the shell draws the card. Adding one to the SDK later breaks nothing; taking one out would.
   - `Icon` draws the names in `APP_ICONS`: `<Icon name="star" />`, with optional `size`, `color` (an app colour), `label` (for screen readers; without it the icon is decorative) and `className`. There are no interface icons such as a plus or a bin yet; a new name is added to `APP_ICONS` and to `packages/sdk/src/web/icon.tsx`, and is not a breaking change.
   - `Checkbox` takes `checked`, `onChange(checked)`, its text as children, `label` when there is no text, and what a checkbox input takes otherwise (`disabled`, `name`). Disabled dims the box and leaves the text readable.
   - `react` and `lucide-react` are dependencies of the SDK. Mini-apps still declare none.
   - The `@source` line names `packages/sdk/src/web`, not all of `packages/sdk/src`: only the kit holds class names.
   - The kit's tests moved with it and run in the SDK. The avatar's test stayed with the avatar. A new end-to-end test checks that the kit's classes reach the built stylesheet, which no unit test can see.
3. **Shared contract and migration 2.** Extend `AppSummary`, `Space`, the error codes and the new request and response schemas; add the tables.
   *Testable:* the migration applies to a version-1 database with data; SQL-level tests for the foreign-key refusal, the cascade on a `space_id` update, `RESTRICT` on data tables and the one-owner index.
4. **Registry and installs on the server.** Add `createApp({ apps })`, `resolveInstall`, add, remove, restore and delete-data routes, the session listing and start-up manifest validation. Add the fixture app `checklist` (manifest only).
   *Testable:* add to a personal space and see it in the session; removed or code-absent apps vanish and answer 404; data survives remove and restore.
5. **Store and query/mutation routes.** Add `defineServer` types, `store.ts`, transactions and error mapping; give `checklist` a server file.
   *Testable:* the two-space isolation test; view versus edit; input validation; `where` key checking; the "no SQL outside `store.ts`" test; a promise-returning handler is refused.
6. **Settings.** Build the schema from the manifest, the two settings routes and `ctx.settings`.
   *Testable:* defaults filled, unknown keys dropped, space keys need edit, user keys are per person.
7. **Build pipeline.** Add `hearth-apps sync` and `check`, the generated registries, the Vite and tsup changes, the version check, the import scan and `@hearth/sdk/eslint`. Add the second fixture `feed` (widget only, user-scope settings).
   *Testable:* build with no apps folder, an empty one and the fixtures; each violation fails with a clear message (wrong version exits 3, foreign import, value import of `./server`, dependency declared, ID not equal to folder).
8. **Widgets and pages in the shell.** Add `AppScope`, `appHooks`, lazy widgets on the dashboard with skeleton and error states, the app page route, polling, session reload on `not_found` and the "Reload to update" card.
   *Testable:* e2e with fixtures: tick an item in the widget, see it on the page; the Content-Security-Policy still holds.
9. **Per-person controls and the settings form.** Add the Apps page with add, switch and pin, plus the generated settings dialog. New strings go in `en.ts` and `zh.ts`.
   *Testable:* e2e: add an app to the personal space without a rebuild, pin it, switch it off, change a setting in both languages.
10. **Groups, members and access.** Add create group, add and remove members, `space_invitations` in `resolveMember`, `can_add_apps`, the access route and a "Family" card in Settings with the member-by-app table.
    *Testable:* a member with no access gets 404 and the app is absent from their session; view cannot mutate; a new member gets the per-app default; a `can_add_apps` member can add.
11. **Move.** Add the route and the dialog.
    *Testable:* rows and space settings arrive; access rows are gone; the mover's pin and own settings survive; the target having the app gives 409; the `sqlite_master` guard test.
12. **Deploy and CI.** Change the deploy script as in A7 and add a handshake-failure case to `deploy/tests/deploy.test.sh`. Add the cross-repository CI job. Update `AGENTS.md`, `docs/architecture.md`, `docs/self-hosting.md` and the server README.
    *Testable:* the deploy tests pass with stand-ins; a version mismatch leaves the old release running.
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
- **SDK version discipline is manual.** The cross-repository CI job catches a break only after it lands on `hearth` main. Tailwind token names are part of the SDK surface.
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
