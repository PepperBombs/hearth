import { useState, type FormEvent } from "react";
import { Button, Checkbox, Chip, EmptyState, Input, Row, Rows, appHooks } from "@hearth/sdk/web";
import type server from "./server";

const { useApp, useQuery, useMutation } = appHooks<typeof server>();

/**
 * The checklist's own page: every item, grouped by the sections the space
 * has set, with a form to add one and a button to clear what is ticked.
 *
 * `settings.sections` belongs to the space and `settings.hideDone` to the
 * reader; both arrive ready to use. Someone who may only look gets the same
 * list with nothing to press.
 */
export default function Page() {
  const { t, canEdit, settings } = useApp();
  const items = useQuery("list");
  const add = useMutation("add");
  const tick = useMutation("tick");
  const clear = useMutation("clearTicked");
  const [name, setName] = useState("");
  const [section, setSection] = useState("");

  const shown = settings.hideDone ? items.filter((item) => !item.done) : items;
  // An item whose section the space no longer has is listed under "Other", with those that never had one.
  const sectionOf = (item: { section: string }) => (settings.sections.includes(item.section) ? item.section : "");
  const groups = [...settings.sections, ""]
    .map((title) => ({ title, items: shown.filter((item) => sectionOf(item) === title) }))
    .filter((group) => group.items.length > 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    // The text stays in the box when the item could not be added.
    add.run({ name, section }).then(
      () => setName(""),
      () => {},
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("add")} aria-label={t("add")} maxLength={80} />
            <Button type="submit" variant="primary" disabled={add.pending || name.trim() === ""}>
              {t("submit")}
            </Button>
          </div>
          {settings.sections.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {settings.sections.map((title) => (
                <Chip key={title} pressed={section === title} onClick={() => setSection(section === title ? "" : title)}>
                  {title}
                </Chip>
              ))}
            </div>
          ) : null}
        </form>
      ) : null}

      {groups.length === 0 ? <EmptyState title={t("empty")} /> : null}
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title || t("other")}>
          {settings.sections.length > 0 ? <h2 className="text-xs font-medium text-fg-3">{group.title || t("other")}</h2> : null}
          <Rows>
            {group.items.map((item) => (
              <Row key={item.id}>
                <Checkbox checked={item.done} disabled={!canEdit} onChange={(done) => tick.run({ id: item.id, done })}>
                  <span className={item.done ? "text-fg-3 line-through" : undefined}>{item.name}</span>
                </Checkbox>
              </Row>
            ))}
          </Rows>
        </section>
      ))}

      {canEdit && items.some((item) => item.done) ? (
        <div>
          <Button size="sm" disabled={clear.pending} onClick={() => clear.run()}>
            {t("clear")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
