import { UserAvatar } from "@/components/custom-ui/avatar";
import { TiptapEditor } from "@/components/tiptap/tiptap-editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppForm } from "@/context/form-context";
import type { IssueChangeEventType, User } from "@/db/schema";
import type { InferDbType } from "@/db/utils";
import { action } from "@/lib/form.utils";
import { issueMappings } from "@/lib/mappings";
import { createComment, deleteComment } from "@/server/issues/comments.api";
import { useQueryClient } from "@tanstack/solid-query";
import type { JSONContent } from "@tiptap/core";
import { formatRelative } from "date-fns";
import EllipsisIcon from "lucide-solid/icons/ellipsis";
import SendHorizontalIcon from "lucide-solid/icons/send-horizontal";
import TrashIcon from "lucide-solid/icons/trash-2";
import { createMemo, createSignal, Index, Match, Show, Switch } from "solid-js";
import * as z from "zod";

const IMPORTANT_EVENT_TYPES: IssueChangeEventType[] = [
  "issue_created",
  "assignee_changed",
  "priority_changed",
] as const;

type IssueWithCommentsAndEvents = InferDbType<
  "issue",
  {
    comments: {
      with: {
        author: true;
      };
    };
    changeEvents: {
      with: {
        actor: true;
      };
    };
  }
>;

type Comment = IssueWithCommentsAndEvents["comments"][number];
type Event = IssueWithCommentsAndEvents["changeEvents"][number];

type CommentTimelineItem = {
  type: "comment";
  date: Date;
  data: Comment;
};

type EventTimelineItem = {
  type: "event";
  date: Date;
  data: Event;
  assignedTo: User | null;
};

export type TimelineItem = CommentTimelineItem | EventTimelineItem;

export type IssueActivityLogProps = {
  issue: IssueWithCommentsAndEvents;
  assignableUsers: User[];
  workspaceSlug: string;
};

export type IssueCommentFormProps = {
  issue: IssueWithCommentsAndEvents;
  workspaceSlug: string;
};

export type IssueCommentItemProps = {
  comment: Comment;
  issueKey: string;
  workspaceSlug: string;
};

export type CommentMenuProps = {
  comment: Comment;
  issueKey: string;
  workspaceSlug: string;
};

export type IssueEventItemProps = {
  event: Event;
  assignedTo: User | null;
};

function buildTimelineItems(
  comments: Comment[],
  events: Event[],
  assignableUsers: User[],
): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const comment of comments) {
    items.push({
      type: "comment",
      date: comment.createdAt,
      data: comment,
    });
  }

  for (const event of events) {
    if (IMPORTANT_EVENT_TYPES.includes(event.eventType)) {
      const assignedToId = event.changes?.assignedToId?.to;
      const assignedTo = assignedToId
        ? (assignableUsers.find((user) => user.id === assignedToId) ?? null)
        : null;

      items.push({
        type: "event",
        date: event.createdAt,
        data: event,
        assignedTo,
      });
    }
  }

  return items.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function formatEventTypeText(eventType: IssueChangeEventType): string {
  switch (eventType) {
    case "issue_created":
      return "created the issue";
    case "assignee_changed":
      return "assigned the issue to ";
    case "priority_changed":
      return "changed the priority to ";
    case "status_changed":
      return "changed the status to ";
    default:
      return eventType;
  }
}

function getEventEntityText(
  event: Event,
  assignedTo: User | null,
): string | undefined {
  switch (event.eventType) {
    case "assignee_changed": {
      const assignedToId = event.changes?.assignedToId?.to;
      if (assignedToId === event.actorId) {
        return "themselves";
      }
      if (assignedTo) {
        return assignedTo.name;
      }
      return assignedToId ?? "nobody";
    }
    case "priority_changed": {
      const toPriority = event.changes?.priority?.to;
      if (!toPriority) return undefined;
      return issueMappings.priority[toPriority].label;
    }
    default:
      return undefined;
  }
}

export function IssueActivityLog(props: IssueActivityLogProps) {
  const timelineItems = createMemo(() =>
    buildTimelineItems(
      props.issue.comments,
      props.issue.changeEvents,
      props.assignableUsers,
    ),
  );

  return (
    <div class="flex flex-col gap-4">
      <Index each={timelineItems()}>
        {(item) => {
          return (
            <Switch>
              <Match when={item().type === "comment"}>
                <IssueCommentItem
                  comment={(item() as CommentTimelineItem).data}
                  issueKey={props.issue.key}
                  workspaceSlug={props.workspaceSlug}
                />
              </Match>
              <Match when={item().type === "event"}>
                <IssueEventItem
                  event={(item() as EventTimelineItem).data}
                  assignedTo={(item() as EventTimelineItem).assignedTo}
                />
              </Match>
            </Switch>
          );
        }}
      </Index>

      <IssueCommentForm
        issue={props.issue}
        workspaceSlug={props.workspaceSlug}
      />
    </div>
  );
}

export function IssueCommentForm(props: IssueCommentFormProps) {
  const queryClient = useQueryClient();

  const form = useAppForm(() => ({
    defaultValues: {
      content: { type: "doc" } as JSONContent,
    },
    validators: {
      onSubmit: z.object({
        content: z.any(), // TODO: Add proper validation
      }),
    },
    onSubmit: async (data) => {
      await createComment({
        data: {
          workspaceSlug: props.workspaceSlug,
          issueKey: props.issue.key,
          content: data.value.content,
        },
      });

      queryClient.invalidateQueries({
        queryKey: ["issue", "get", props.workspaceSlug, props.issue.key],
      });
      form.reset();
    },
  }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      class="relative"
    >
      <form.AppField name="content">
        {(field) => (
          <TiptapEditor
            content={field().state.value}
            onChange={(content) => field().handleChange(content)}
            placeholder="Add a comment..."
            variant="plain"
            class="min-h-24 p-4 squircle-lg bg-accent border"
          />
        )}
      </form.AppField>

      <form.Subscribe>
        {(state) => (
          <Button
            type="submit"
            size="sm"
            disabled={!state().canSubmit || !state().isTouched}
            class="absolute bottom-4 right-4 px-1.5! aspect-square"
          >
            <SendHorizontalIcon class="size-4" />
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

export function CommentMenu(props: CommentMenuProps) {
  const queryClient = useQueryClient();
  const [deleteDialogOpen, setDeleteDialogOpen] = createSignal(false);

  const handleDelete = async () => {
    await action(
      deleteComment({
        data: {
          workspaceSlug: props.workspaceSlug,
          issueKey: props.issueKey,
          commentId: props.comment.id,
        },
      }),
    );

    queryClient.invalidateQueries({
      queryKey: ["issue", "get", props.workspaceSlug, props.issueKey],
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          as={Button}
          variant="ghost"
          size="iconXs"
          class="ml-auto"
        >
          <EllipsisIcon class="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteDialogOpen(true)}
          >
            <TrashIcon class="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteDialogOpen()} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia class="bg-destructive/50">
              <TrashIcon class="size-4" />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              comment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="xs"
              variant="destructive"
              action={handleDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function IssueCommentItem(props: IssueCommentItemProps) {
  return (
    <div class="p-4 squircle-lg bg-accent border flex flex-col gap-2">
      <div class="flex flex-row gap-1 items-center">
        <UserAvatar user={props.comment.author} size="xs" />
        <p class="font-medium">{props.comment.author.name}</p>
        <p class="text-muted-foreground ml-1">
          {formatRelative(props.comment.createdAt, new Date())}
        </p>
        <CommentMenu
          comment={props.comment}
          issueKey={props.issueKey}
          workspaceSlug={props.workspaceSlug}
        />
      </div>

      <Show when={props.comment.content}>
        {(content) => (
          <TiptapEditor content={content()} editable={false} variant="plain" />
        )}
      </Show>
    </div>
  );
}

export function IssueEventItem(props: IssueEventItemProps) {
  const eventTypeText = createMemo(() =>
    formatEventTypeText(props.event.eventType),
  );
  const eventEntityText = createMemo(() =>
    getEventEntityText(props.event, props.assignedTo),
  );

  return (
    <div class="flex flex-row gap-1 flex-wrap items-center text-muted-foreground text-sm pl-4">
      <UserAvatar user={props.event.actor} size="5" />
      <p>{props.event.actor.name}</p>
      <p class="font-medium">{eventTypeText()}</p>
      <Show when={eventEntityText()}>{(entity) => <p>{entity()}</p>}</Show>
      <span class="text-muted-foreground">•</span>
      <p class="text-muted-foreground">
        {formatRelative(props.event.createdAt, new Date())}
      </p>
    </div>
  );
}
