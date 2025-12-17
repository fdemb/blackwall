import type { JSONContent } from "@tiptap/core";
import { createContext, useContext, type JSX } from "solid-js";

export const IssueEditingContext = createContext<{
  setSummary: (summary: string) => void;
  setDescription: (content: JSONContent) => void;
}>();

export const useIssueEditingContext = () => {
  const context = useContext(IssueEditingContext);
  if (!context) {
    throw new Error(
      "useIssueEditingContext must be used within an IssueEditingContext provider",
    );
  }
  return context;
};

export const IssueEditingProvider = (props: {
  children: JSX.Element;
  onSummaryChange: (summary: string) => void;
  onDescriptionChange: (content: JSONContent) => void;
}) => {
  return (
    <IssueEditingContext.Provider
      value={{
        setSummary: props.onSummaryChange,
        setDescription: props.onDescriptionChange,
      }}
    >
      {props.children}
    </IssueEditingContext.Provider>
  );
};
