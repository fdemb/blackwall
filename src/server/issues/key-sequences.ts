import { db, dbSchema, type DbTransaction } from "@/db";
import { AppError } from "@/server/shared/errors";
import { and, eq, sql } from "drizzle-orm";

/**
 * Ensures a sequence exists for a workspace/team pair.
 * This is idempotent - if the sequence already exists, it does nothing.
 */
export async function ensureSequenceExists(input: {
  workspaceId: string;
  teamId: string;
  tx?: DbTransaction;
}): Promise<void> {
  const transactionalDb = input.tx ?? db;

  await transactionalDb
    .insert(dbSchema.issueSequence)
    .values({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      currentSequence: 0,
    })
    .onConflictDoNothing();
}

/**
 * Initializes a sequence for a workspace/team pair.
 * Use this when creating a new team to set up the sequence upfront.
 */
export async function initializeSequence(input: {
  workspaceId: string;
  teamId: string;
}): Promise<void> {
  await db.insert(dbSchema.issueSequence).values({
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    currentSequence: 0,
  });
}

/**
 * Atomically increments and returns the next sequence number for a workspace/team pair.
 * This function ensures the sequence exists before incrementing.
 */
export async function getNextSequenceNumber(input: {
  workspaceId: string;
  teamId: string;
  tx?: DbTransaction;
}): Promise<number> {
  await ensureSequenceExists(input);

  const transactionalDb = input.tx ?? db;

  const [updated] = await transactionalDb
    .update(dbSchema.issueSequence)
    .set({
      currentSequence: sql`${dbSchema.issueSequence.currentSequence} + 1`,
    })
    .where(
      and(
        eq(dbSchema.issueSequence.workspaceId, input.workspaceId),
        eq(dbSchema.issueSequence.teamId, input.teamId),
      ),
    )
    .returning();

  if (!updated) {
    throw new AppError(
      "INTERNAL_SERVER_ERROR",
      "Failed to get next sequence number.",
    );
  }

  return updated.currentSequence;
}

export async function getNextSequenceNumbers(input: {
  workspaceId: string;
  teamId: string;
  count: number;
  tx?: DbTransaction;
}): Promise<number[]> {
  await ensureSequenceExists(input);

  const transactionalDb = input.tx ?? db;

  const [updated] = await transactionalDb
    .update(dbSchema.issueSequence)
    .set({
      currentSequence: sql`${dbSchema.issueSequence.currentSequence} + ${input.count}`,
    })
    .where(
      and(
        eq(dbSchema.issueSequence.workspaceId, input.workspaceId),
        eq(dbSchema.issueSequence.teamId, input.teamId),
      ),
    )
    .returning();

  if (!updated) {
    throw new AppError(
      "INTERNAL_SERVER_ERROR",
      "Failed to get next sequence numbers.",
    );
  }

  const endNumber = updated.currentSequence;
  const startNumber = endNumber - input.count + 1;

  return Array.from({ length: input.count }, (_, i) => startNumber + i);
}
