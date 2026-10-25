import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestProject } from "vite-plus/test/node";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));

export async function sql(url: string, statement: string): Promise<string> {
  const { stdout } = await execute(
    "psql",
    ["--dbname", url, "-X", "-v", "ON_ERROR_STOP=1", "-Atc", statement],
    { cwd: root },
  );
  return stdout.trim();
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

export default async function setup(project: TestProject) {
  if (process.env.SYNC_CONTRACT !== "1" || !process.env.TEST_POSTGRES_URL) {
    console.info(
      "Sync contract tests skipped: set SYNC_CONTRACT=1 and TEST_POSTGRES_URL to enable them.",
    );
    return;
  }
  const adminUrl = process.env.TEST_POSTGRES_URL;
  const database = `blackwall_contract_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(adminUrl);
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol))
    throw new Error("TEST_POSTGRES_URL must use PostgreSQL");
  databaseUrl.pathname = `/${database}`;
  await execute("cargo", ["build", "--locked"], { cwd: root, timeout: 300_000 });
  const temporary = await mkdtemp(`${tmpdir()}/blackwall-contract-`);
  let created = false;
  let processHandle: ReturnType<typeof spawn> | undefined;
  let log = "";
  let spawnError: Error | undefined;
  const cleanup = async () => {
    try {
      if (
        processHandle?.pid &&
        processHandle.exitCode === null &&
        processHandle.signalCode === null
      ) {
        const child = processHandle;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        });
      }
    } finally {
      try {
        if (created) await sql(adminUrl, `DROP DATABASE ${database} WITH (FORCE)`);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  };
  try {
    await sql(adminUrl, `CREATE DATABASE ${database}`);
    created = true;
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const { SMTP_URL: _smtp, SMTP_FROM: _from, ...environment } = process.env;
    processHandle = spawn(`${root}/target/debug/blackwall`, ["serve"], {
      cwd: temporary,
      env: {
        ...environment,
        // Mail on, so invitations queue an email job as they do in production.
        DEV_MAIL_DIR: `${temporary}/mail`,
        DATABASE_URL: databaseUrl.href,
        BIND_ADDR: `127.0.0.1:${port}`,
        WEB_DIR: temporary,
        COOKIE_SECURE: "false",
        RUST_LOG: "blackwall=warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processHandle.on("error", (error) => {
      spawnError = error;
    });
    const append = (data: Buffer) => {
      log = (log + data.toString()).slice(-16_000);
    };
    processHandle.stdout?.on("data", append);
    processHandle.stderr?.on("data", append);
    const deadline = Date.now() + 30_000;
    while (true) {
      if (spawnError || processHandle.exitCode !== null || processHandle.signalCode !== null)
        throw new Error(`contract server exited: ${spawnError?.message ?? log}`);
      try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {
        /* Startup may not have bound the listener yet. */
      }
      if (Date.now() > deadline) throw new Error(`contract server health timed out: ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    project.provide("syncContract", { baseUrl, databaseUrl: databaseUrl.href });
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
