import type { getWorkspaceAndGlobalData } from "@/features/workspaces/actions";
import { createContext, useContext } from "solid-js";

export type WorkspaceDataContextType = Awaited<
  ReturnType<typeof getWorkspaceAndGlobalData>
>;

export const WorkspaceDataContext = createContext<WorkspaceDataContextType>();

export const useWorkspaceData = () => {
  const ctx = useContext(WorkspaceDataContext);

  if (!ctx) {
    throw new Error("useWorkspace called outside WorkspaceContext.");
  }

  return ctx;
};
