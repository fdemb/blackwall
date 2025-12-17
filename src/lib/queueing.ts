import Database from "bun:sqlite";
import { bun, defineQueue } from "plainjob";
import { env } from "./zod-env";

export const noDebugLogger = {
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: () => {},
};

const connection = bun(new Database(env.QUEUE_DATABASE_URL, { strict: true }));
const queue = defineQueue({ connection, logger: noDebugLogger });

export default queue;
