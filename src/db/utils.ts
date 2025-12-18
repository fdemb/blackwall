import type {
  BuildQueryResult,
  DBQueryConfig,
  ExtractTablesWithRelations,
} from "drizzle-orm";
import * as sqlite from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import * as schema from "./schema";

export const lifecycleTimestamps = {
  createdAt: sqlite
    .integer({ mode: "timestamp_ms" })
    .notNull()
    .$default(() => new Date()),
  updatedAt: sqlite
    .integer({ mode: "timestamp_ms" })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
  deletedAt: sqlite.integer({ mode: "timestamp_ms" }),
};

export const nanoidPk = sqlite
  .text({ length: 21 })
  .$default(nanoid)
  .primaryKey();

type Schema = typeof schema;
type TSchema = ExtractTablesWithRelations<Schema>;

export type IncludeRelation<TableName extends keyof TSchema> = DBQueryConfig<
  "one" | "many",
  boolean,
  TSchema,
  TSchema[TableName]
>["with"];

export type InferDbType<
  TableName extends keyof TSchema,
  With extends IncludeRelation<TableName> | undefined = undefined,
> = BuildQueryResult<
  TSchema,
  TSchema[TableName],
  {
    with: With;
  }
>;
