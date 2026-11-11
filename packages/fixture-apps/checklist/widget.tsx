import { Checkbox, EmptyState, Row, Rows, appHooks } from "@hearth/sdk/web";
import type server from "./server";

const { useApp, useQuery, useMutation } = appHooks<typeof server>();

/**
 * The body of the checklist's card on the dashboard: the first few things
 * still to do, each with a box to tick it off, and how many are left.
 *
 * The shell draws the card around it (icon, name, the space's tag and the
 * link to the page), and what is shown while the list loads or when it
 * cannot be loaded. `useQuery` gives the answer of the `list` route in
 * server.ts; ticking a box calls `tick`, after which the list is read again.
 */
export default function Widget() {
  const { t, canEdit } = useApp();
  const open = useQuery("list").filter((item) => !item.done);
  const tick = useMutation("tick");

  if (open.length === 0) return <EmptyState level={3} title={t("empty")} className="min-h-[88px] justify-center py-2" />;
  return (
    <div className="flex min-h-[88px] flex-1 flex-col">
      <Rows>
        {open.slice(0, 6).map((item) => (
          <Row key={item.id}>
            <Checkbox checked={false} disabled={!canEdit} onChange={() => tick.run({ id: item.id, done: true })}>
              {item.name}
            </Checkbox>
          </Row>
        ))}
      </Rows>
      <p className="num mt-auto pt-2 text-xs text-fg-3">{t("left", { count: open.length })}</p>
    </div>
  );
}
