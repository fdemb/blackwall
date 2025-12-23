import { TiptapEditor } from "@/components/tiptap/tiptap-editor";
import { useIssueEditingContext } from "@/context/issue-editing.context";
import { useWorkspaceData } from "@/context/workspace-context";
import type { Issue } from "@/db/schema";
import { uploadAttachment } from "@/server/issues/attachments.api";

export function IssueDescription(props: { issue: Issue }) {
  const { setDescription } = useIssueEditingContext();
  const workspaceData = useWorkspaceData();

  const handleUpload = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("workspaceSlug", workspaceData().workspace.slug);
    formData.append("issueKey", props.issue.key);

    const attachment = await uploadAttachment({ data: formData });
    return attachment;
  };

  return (
    <div class="pt-6">
      <TiptapEditor
        initialContent={props.issue.description}
        onChange={(content) => {
          setDescription(content);
        }}
        onAttachmentUpload={handleUpload}
        workspaceSlug={workspaceData().workspace.slug}
        variant="plain"
        editable={false}
        editableOnClick={true}
      />
    </div>
  );
}
