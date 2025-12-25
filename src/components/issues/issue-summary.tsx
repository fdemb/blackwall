import { useWorkspaceData } from "@/context/workspace-context";
import type { Issue } from "@/db/schema";
import { action } from "@/lib/form.utils";
import { updateSummary } from "@/server/issues/issues.api";
import { useServerFn } from "@tanstack/solid-start";
import CheckIcon from "lucide-solid/icons/check";
import XIcon from "lucide-solid/icons/x";
import { createSignal, Show } from "solid-js";
import { Button } from "../ui/button";

export function IssueSummary(props: { issue: Issue }) {
  const workspaceData = useWorkspaceData();
  const updateSummaryFn = useServerFn(updateSummary);
  const [isEditing, setIsEditing] = createSignal(false);
  const [summary, setSummary] = createSignal(props.issue.summary);

  function save() {
    if (summary() === props.issue.summary) {
      setIsEditing(false);
      return;
    }

    action(
      updateSummaryFn({
        data: {
          summary: summary(),
          workspaceSlug: workspaceData().workspace.slug,
          issueKey: props.issue.key,
        },
      }),
    );

    setIsEditing(false);
    setSummary(props.issue.summary);
  }

  return (
    <div class="relative">
      <h1
        contentEditable={true}
        onPointerDown={() => {
          setIsEditing(true);
        }}
        class="w-full text-xl sm:text-2xl font-medium outline-none"
        onInput={(e) => {
          setSummary(e.target.textContent);
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData?.getData("text/plain") ?? "";
          e.target.textContent = text;
          setSummary(text);
        }}
        onBlur={save}
      >
        {props.issue.summary}
      </h1>

      <Show when={isEditing()}>
        <div class="flex flex-row gap-2 absolute -bottom-11 left-0 z-100 bg-muted p-1 border rounded-md">
          <Button size="iconXs" variant="default" onClick={save}>
            <CheckIcon class="size-4" />
          </Button>
          <Button
            size="iconXs"
            variant="outline"
            onClick={() => setIsEditing(false)}
          >
            <XIcon class="size-4" />
          </Button>
        </div>
      </Show>
    </div>
  );
}
