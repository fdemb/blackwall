import { useCallback, useMemo, useState } from "react";
import {
  Autocomplete,
  Input,
  Menu,
  MenuItem,
  MenuSection,
  Header,
  SearchField,
  ModalOverlay,
  Modal,
  Dialog as RACDialog,
} from "react-aria-components";
import { useNavigate } from "react-router";
import {
  Bell,
  BarChart3,
  Keyboard,
  Search,
  Settings,
  Trash2,
  UserRound,
  Inbox,
  FolderKanban,
  Users,
  Plus,
  Layers,
} from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Kbd } from "~/components/ui/tooltip";
import { issueKey } from "~/lib/format";
import { IssueKey, issueKeyLength } from "./issue-key";
import { useI18n } from "~/lib/i18n";
import { useShortcutsEnabled } from "~/lib/shortcuts";
import { useIssues } from "~/lib/queries";
import { QueryStatus } from "./query-status";
import { useWorkspace } from "~/lib/workspace";
import { PriorityIcon, StageIcon } from "./icons";
import { stageOf } from "~/lib/filters";

interface Entry {
  id: string;
  label: string;
  icon: React.ReactNode;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onHelp,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onHelp: () => void;
}) {
  const { t } = useI18n();
  const nav = useNavigate();
  const { ws, members, create, canWrite } = useWorkspace();
  const [shortcuts] = useShortcutsEnabled();
  // `open` stays controlled by the parent (the global shortcut owns it). `q` stays local: nothing
  // outside the modal reads it, so a provider would add indirection without sharing.
  const [q, setQ] = useState("");
  const go = useCallback(
    (path: string) => () => {
      onOpenChange(false);
      void nav(`/${ws.id}/${path}`);
    },
    [onOpenChange, nav, ws.id],
  );

  const actions: Entry[] = useMemo(
    () => [
      // Viewers can't create issues, so the command isn't offered to them.
      ...(canWrite
        ? [
            {
              id: "a-new",
              label: t("issue.new"),
              icon: <Plus className="size-4" />,
              hint: shortcuts ? "C" : undefined,
              run: () => {
                onOpenChange(false);
                create.show();
              },
            },
          ]
        : []),
      {
        id: "a-inbox",
        label: t("nav.inbox"),
        icon: <Inbox className="size-4" />,
        run: go("inbox"),
      },
      {
        id: "a-my",
        label: t("nav.myIssues"),
        icon: <UserRound className="size-4" />,
        run: go("my-issues"),
      },
      {
        id: "a-issues",
        label: t("nav.allIssues"),
        icon: <Layers className="size-4" />,
        run: go("issues"),
      },
      {
        id: "a-projects",
        label: t("nav.projects"),
        icon: <FolderKanban className="size-4" />,
        run: go("projects"),
      },
      {
        id: "a-people",
        label: t("nav.people"),
        icon: <Users className="size-4" />,
        run: go("people"),
      },
      {
        id: "a-reports",
        label: t("nav.reports"),
        icon: <BarChart3 className="size-4" />,
        run: go("reports"),
      },
      {
        id: "a-trash",
        label: t("nav.trash"),
        icon: <Trash2 className="size-4" />,
        run: go("trash"),
      },
      {
        id: "a-settings",
        label: t("nav.settings"),
        icon: <Settings className="size-4" />,
        run: go("settings/general"),
      },
      {
        id: "a-account",
        label: t("nav.account"),
        icon: <Bell className="size-4" />,
        run: go("settings/profile"),
      },
      {
        id: "a-help",
        label: t("help.shortcuts"),
        icon: <Keyboard className="size-4" />,
        run: () => {
          onOpenChange(false);
          onHelp();
        },
      },
      ...ws.teams.map((tm) => ({
        id: `t-${tm.id}`,
        label: `${tm.name} · ${t("team.board")}`,
        icon: <Layers className="size-4" />,
        run: go(`team/${tm.id}/board`),
      })),
    ],
    [t, ws.teams, canWrite, shortcuts, go, onOpenChange, create, onHelp],
  );

  const query = q.trim().toLowerCase();
  const liveQuery = useIssues({ search: query, sort: "updated" }, open);
  // Archived issues hide from listings but stay findable here, after live matches.
  const archivedQuery = useIssues(
    { search: query, sort: "updated", archived: true },
    open && query !== "",
  );
  const issues = useMemo(() => {
    if (!query) return liveQuery.items.slice(0, 5);
    const seen = new Set(liveQuery.items.map((i) => i.id));
    return [...liveQuery.items, ...archivedQuery.items.filter((i) => !seen.has(i.id))].slice(0, 8);
  }, [query, liveQuery.items, archivedQuery.items]);
  const issueQuery = liveQuery;
  const keyLength = issueKeyLength(issues);
  const people = query
    ? members
        .filter(
          (m) =>
            m.display_name.toLowerCase().includes(query) || m.email.toLowerCase().includes(query),
        )
        .slice(0, 5)
    : [];
  const acts = query
    ? actions.filter((a) => a.label.toLowerCase().includes(query))
    : actions.slice(0, 6);

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQ("");
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[14vh] backdrop-blur-[2px] entering:animate-in entering:fade-in-0 exiting:animate-out exiting:fade-out-0"
    >
      <Modal className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover shadow-2xl entering:animate-in entering:zoom-in-95 exiting:animate-out exiting:zoom-out-95">
        <RACDialog aria-label={t("search.title")} className="outline-none">
          <Autocomplete inputValue={q} onInputChange={setQ} filter={() => true}>
            <SearchField
              autoFocus
              aria-label={t("search.title")}
              className="flex items-center gap-2 border-b border-border px-4 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/60"
            >
              <Search aria-hidden className="size-4 text-muted-foreground" />
              <Input
                placeholder={t("search.placeholder")}
                className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
              />
              <Kbd>esc</Kbd>
            </SearchField>
            <QueryStatus query={{ ...issueQuery, hasMore: false }} />
            <Menu
              aria-label={t("search.title")}
              className="max-h-[50vh] overflow-auto overscroll-contain p-1.5 outline-none"
              renderEmptyState={() => (
                <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                  {t("search.empty")}
                </p>
              )}
            >
              {issues.length > 0 && (
                <MenuSection>
                  <Header className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("search.issues")}
                  </Header>
                  {issues.map((i) => {
                    const s = stageOf(ws, i);
                    return (
                      <Row
                        key={i.id}
                        id={`i-${i.id}`}
                        text={`${issueKey(i.number)} ${i.title}`}
                        onAction={() => {
                          onOpenChange(false);
                          void nav(`/${ws.id}/issue/${i.id}`);
                        }}
                      >
                        <PriorityIcon priority={i.priority} />
                        <IssueKey
                          number={i.number}
                          length={keyLength}
                          className="text-muted-foreground"
                        />
                        <span className="flex-1 truncate">{i.title}</span>
                        {i.archived_at && (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            {t("filter.archived")}
                          </span>
                        )}
                        {s && <StageIcon kind={s.kind} />}
                      </Row>
                    );
                  })}
                </MenuSection>
              )}
              {people.length > 0 && (
                <MenuSection>
                  <Header className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("search.people")}
                  </Header>
                  {people.map((m) => (
                    <Row
                      key={m.id}
                      id={`p-${m.id}`}
                      text={m.display_name}
                      onAction={() => {
                        onOpenChange(false);
                        void nav(`/${ws.id}/people/${m.id}`);
                      }}
                    >
                      <Avatar name={m.display_name} src={m.avatar_url} size={18} />
                      <span className="flex-1 truncate">{m.display_name}</span>
                      <span className="text-xs text-muted-foreground">{m.email}</span>
                    </Row>
                  ))}
                </MenuSection>
              )}
              {acts.length > 0 && (
                <MenuSection>
                  <Header className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("search.actions")}
                  </Header>
                  {acts.map((a) => (
                    <Row key={a.id} id={a.id} text={a.label} onAction={a.run}>
                      <span aria-hidden className="text-muted-foreground">
                        {a.icon}
                      </span>
                      <span className="flex-1">{a.label}</span>
                      {a.hint && <Kbd>{a.hint}</Kbd>}
                    </Row>
                  ))}
                </MenuSection>
              )}
            </Menu>
          </Autocomplete>
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}

function Row({
  id,
  text,
  onAction,
  children,
}: {
  id: string;
  text: string;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <MenuItem
      id={id}
      textValue={text}
      onAction={onAction}
      className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] outline-none focus:bg-accent focus:text-accent-foreground"
    >
      {children}
    </MenuItem>
  );
}
