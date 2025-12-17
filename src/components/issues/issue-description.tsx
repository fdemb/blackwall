import { TiptapEditor } from "@/components/tiptap/tiptap-editor";
import { useIssueEditingContext } from "@/context/issue-editing.context";
import type { Issue } from "@/db/schema";

export function IssueDescription(props: { issue: Issue }) {
  const { setDescription } = useIssueEditingContext();
  return (
    <div class="pt-6">
      <TiptapEditor
        initialContent={props.issue.description}
        onChange={(content) => {
          setDescription(content);
        }}
        variant="plain"
        editable={false}
        editableOnClick={true}
      />
    </div>
  );
}
