import { TiptapEditor } from "@/components/tiptap/tiptap-editor";
import { useWorkspaceData } from "@/context/workspace-context";
import type { Issue } from "@/db/schema";
import { action } from "@/lib/form.utils";
import { uploadAttachment } from "@/server/issues/attachments.api";
import { updateDescription } from "@/server/issues/issues.api";
import { useServerFn } from "@tanstack/solid-start";
import type { JSONContent } from "@tiptap/core";
import CheckIcon from "lucide-solid/icons/check";
import XIcon from "lucide-solid/icons/x";
import { createSignal, Show } from "solid-js";
import { Button } from "../ui/button";

export function IssueDescription(props: { issue: Issue }) {
  const workspaceData = useWorkspaceData();
  const updateDescriptionFn = useServerFn(updateDescription);
  const [description, setDescription] = createSignal<JSONContent>(
    props.issue.description,
  );
  const [isEditing, setIsEditing] = createSignal(false);

  const handleUpload = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("workspaceSlug", workspaceData().workspace.slug);
    formData.append("issueKey", props.issue.key);

    const attachment = await uploadAttachment({ data: formData });
    return attachment;
  };

  const save = () => {
    if (
      JSON.stringify(description()) === JSON.stringify(props.issue.description)
    ) {
      setIsEditing(false);
      return;
    }

    action(
      updateDescriptionFn({
        data: {
          workspaceSlug: workspaceData().workspace.slug,
          issueKey: props.issue.key,
          description: description(),
        },
      }),
    );
    setIsEditing(false);
  };

  const cancel = () => {
    setDescription(props.issue.description);
    setIsEditing(false);
  };

  return (
    <div class="pt-6 relative">
      <TiptapEditor
        content={description()}
        onChange={(content) => {
          setDescription(content);
        }}
        onAttachmentUpload={handleUpload}
        workspaceSlug={workspaceData().workspace.slug}
        onBlur={save}
        variant="plain"
        editable={isEditing()}
        onPointerDown={() => {
          setIsEditing(true);
        }}
      />

      <Show when={isEditing()}>
        <div class="flex flex-row gap-2 absolute -bottom-11 left-0 z-100 bg-muted p-1 border rounded-md">
          <Button size="iconXs" variant="default" onClick={save}>
            <CheckIcon class="size-4" />
          </Button>
          <Button size="iconXs" variant="outline" onClick={cancel}>
            <XIcon class="size-4" />
          </Button>
        </div>
      </Show>
    </div>
  );
}
