import { useState } from "react";
import {
  Autocomplete,
  DialogTrigger,
  Dialog,
  Menu,
  MenuItem,
  SearchField,
  Input,
} from "react-aria-components";
import { Search } from "lucide-react";
import { Popover } from "~/components/ui/popover";
import { stageOf } from "~/lib/filters";
import { issueKey } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { useIssues } from "~/lib/queries";
import { QueryStatus } from "./query-status";
import { useWorkspace } from "~/lib/workspace";
import type { Id } from "~/lib/types";
import { StageIcon } from "./icons";

export function IssuePicker({
  trigger,
  onPick,
  exclude = [],
}: {
  trigger: React.ReactNode;
  onPick: (id: Id) => void;
  exclude?: Id[];
}) {
  const t = useT();
  const { ws } = useWorkspace();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const query = useIssues({ search: q, sort: "updated" }, open);
  const excluded = new Set(exclude);
  const results = query.items.filter((i) => !excluded.has(i.id)).slice(0, 30);
  return (
    <DialogTrigger
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      {trigger}
      <Popover placement="bottom start" className="w-80">
        <Dialog aria-label={t("issue.find")} className="outline-none">
          {({ close }) => (
            <Autocomplete inputValue={q} onInputChange={setQ} filter={() => true}>
              <SearchField
                autoFocus
                aria-label={t("issue.find")}
                className="flex items-center gap-2 border-b border-border px-3"
              >
                <Search aria-hidden className="size-3.5 text-muted-foreground" />
                <Input
                  placeholder={t("issue.findPlaceholder")}
                  className="h-9 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
                />
              </SearchField>
              <Menu
                aria-label={t("issue.find")}
                items={results}
                onAction={(k) => {
                  onPick(String(k));
                  close();
                }}
                className="max-h-64 overflow-auto overscroll-contain p-1 outline-none"
                renderEmptyState={() => (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                    {t("search.empty")}
                  </p>
                )}
              >
                {(i) => {
                  const s = stageOf(ws, i);
                  return (
                    <MenuItem
                      id={i.id}
                      textValue={`${issueKey(i.number)} ${i.title}`}
                      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none focus:bg-accent"
                    >
                      {s && <StageIcon kind={s.kind} />}
                      <span className="w-12 shrink-0 tabular-nums text-muted-foreground">
                        {issueKey(i.number)}
                      </span>
                      <span className="truncate">{i.title}</span>
                    </MenuItem>
                  );
                }}
              </Menu>
              <QueryStatus query={query} />
            </Autocomplete>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
