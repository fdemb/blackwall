import { MutationError } from "../mutators";
import { parseTimestamp } from "../records";

interface Node {
  value: unknown;
  start: number;
  end: number;
  fields?: Map<string, Node>;
  items?: Node[];
  duplicates?: { key: string; end: number }[];
}

/** Axum Json<PushRequest> rejects the envelope before sync_push can run. */
export async function extractPushJson(request: Request): Promise<unknown> {
  const mime = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!mime || !/^application\/(?:json|[^\s/]+\+json)$/.test(mime)) {
    throw new MutationError(415, "Expected request with `Content-Type: application/json`");
  }
  const source = await request.text();
  const parser = new JsonParser(source);
  const root = parser.parse();
  const reject = (node: Node, path: string, message: string): never => {
    throw new MutationError(
      422,
      `Failed to deserialize the JSON body into the target type: ${path ? `${path}: ` : ""}${message} ${parser.location(message.startsWith("invalid type") && (node.items || node.fields) ? node.start : node.end)}`,
    );
  };
  const actual = (node: Node): string => {
    const value = node.value;
    if (value === null) return "null";
    if (typeof value === "string") return `string ${JSON.stringify(value)}`;
    if (typeof value === "boolean") return `boolean \`${value}\``;
    if (typeof value === "number")
      return `${/[.eE]/.test(source.slice(node.start, node.end)) ? "floating point" : "integer"} \`${source.slice(node.start, node.end)}\``;
    return Array.isArray(value) ? "sequence" : "map";
  };
  const required = (node: Node, field: string, path: string): Node => {
    const child = node.fields?.get(field);
    if (!child) return reject(node, path, `missing field \`${field}\``);
    return child;
  };
  if (!root.fields) reject(root, "", `invalid type: ${actual(root)}, expected struct PushRequest`);
  for (const duplicate of root.duplicates ?? []) {
    if (["client_id", "mutations"].includes(duplicate.key))
      reject({ ...root, end: duplicate.end }, "", `duplicate field \`${duplicate.key}\``);
  }
  // Check fields in input order, as the streaming Serde deserializer does.
  for (const [key, node] of root.fields ?? []) {
    if (key === "client_id") {
      if (typeof node.value !== "string")
        reject(node, key, `invalid type: ${actual(node)}, expected a UUID string`);
      if (
        typeof node.value === "string" &&
        !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(node.value)
      ) {
        reject(node, key, `UUID parsing failed: invalid length: found ${node.value.length}`);
      }
    } else if (key === "mutations") {
      if (!node.items) reject(node, key, `invalid type: ${actual(node)}, expected a sequence`);
      for (const [index, mutation] of (node.items ?? []).entries()) {
        const path = `mutations[${index}]`;
        if (!mutation.fields)
          reject(mutation, path, `invalid type: ${actual(mutation)}, expected struct SyncMutation`);
        for (const duplicate of mutation.duplicates ?? []) {
          if (["id", "name", "args", "at"].includes(duplicate.key))
            reject(
              { ...mutation, end: duplicate.end },
              path,
              `duplicate field \`${duplicate.key}\``,
            );
        }
        for (const [field, value] of mutation.fields ?? []) {
          const atPath = `${path}.${field}`;
          if (field === "id") {
            if (
              typeof value.value !== "number" ||
              /[.eE]/.test(source.slice(value.start, value.end))
            )
              reject(value, atPath, `invalid type: ${actual(value)}, expected i64`);
            if (
              typeof value.value === "number" &&
              (value.value < -(2 ** 63) || value.value >= 2 ** 63)
            )
              reject(value, atPath, `invalid value: ${actual(value)}, expected i64`);
          } else if (field === "name" && typeof value.value !== "string") {
            reject(value, atPath, `invalid type: ${actual(value)}, expected a string`);
          } else if (field === "at") {
            if (typeof value.value !== "string")
              reject(
                value,
                atPath,
                `invalid type: ${actual(value)}, expected an RFC 3339 formatted date and time string`,
              );
            try {
              parseTimestamp(value.value, true);
            } catch (error) {
              reject(
                value,
                atPath,
                error instanceof Error &&
                  ["premature end of input", "input is out of range"].includes(error.message)
                  ? error.message
                  : "input contains invalid characters",
              );
            }
          }
        }
        for (const field of ["id", "name", "at"]) required(mutation, field, path);
      }
    }
  }
  required(root, "client_id", "");
  required(root, "mutations", "");
  return root.value;
}

/** Retain token ends so extraction errors carry Serde's UTF-8 line/column. */
class JsonParser {
  private offset = 0;
  private path = "";
  constructor(private readonly source: string) {}
  location(end: number): string {
    const lines = this.source.slice(0, end).split("\n");
    return `at line ${lines.length} column ${new TextEncoder().encode(lines[lines.length - 1]).length}`;
  }
  private fail(message: string, end = this.offset): never {
    throw new MutationError(
      400,
      `Failed to parse the request body as JSON: ${this.path ? `${this.path}: ` : ""}${message} ${this.location(end)}`,
    );
  }
  private whitespace(): void {
    while (/[\t\n\r ]/.test(this.source[this.offset] ?? "x")) this.offset++;
  }
  parse(): Node {
    const node = this.node(0);
    this.whitespace();
    if (this.offset < this.source.length) this.fail("trailing characters", this.offset + 1);
    return node;
  }
  private node(depth: number, path = ""): Node {
    const previous = this.path;
    this.path = path;
    try {
      return this.parseNode(depth, path);
    } finally {
      this.path = previous;
    }
  }
  private parseNode(depth: number, path: string): Node {
    this.whitespace();
    const start = this.offset;
    const token = this.source[this.offset];
    if (!token) this.fail("EOF while parsing a value");
    if (token === "{" || token === "[") return this.container(token, start, depth, path);
    if (token === '"') this.string();
    else this.scalar(token);
    try {
      const value: unknown = JSON.parse(this.source.slice(start, this.offset));
      if (typeof value === "number" && !Number.isFinite(value)) this.fail("number out of range");
      return { value, start, end: this.offset };
    } catch (error) {
      if (error instanceof MutationError) throw error;
      this.fail("invalid escape");
    }
  }

  private container(token: "{" | "[", start: number, depth: number, path: string): Node {
    if (depth >= 127) this.fail("recursion limit exceeded", this.offset + 1);
    this.offset++;
    const fields = new Map<string, Node>();
    const duplicates: { key: string; end: number }[] = [];
    const items: Node[] = [];
    const close = token === "{" ? "}" : "]";
    const context = token === "{" ? "an object" : "a list";
    this.whitespace();
    if (this.source[this.offset] !== close) {
      for (;;) {
        if (this.offset >= this.source.length) this.fail(`EOF while parsing ${context}`);
        if (token === "{") {
          if (this.source[this.offset] !== '"') this.fail("key must be a string", this.offset + 1);
          const keyNode = this.node(depth + 1);
          const key = keyNode.value;
          this.whitespace();
          if (this.source[this.offset] !== ":")
            this.fail(
              this.offset >= this.source.length ? "EOF while parsing an object" : "expected `:`",
              this.offset + (this.offset < this.source.length ? 1 : 0),
            );
          this.offset++;
          if (typeof key === "string") {
            const value = this.node(depth + 1, path ? `${path}.${key}` : key);
            if (fields.has(key)) duplicates.push({ key, end: keyNode.end });
            fields.set(key, value);
          }
        } else items.push(this.node(depth + 1, `${path}[${items.length}]`));
        this.whitespace();
        if (this.source[this.offset] === close) break;
        if (this.offset >= this.source.length) this.fail(`EOF while parsing ${context}`);
        if (this.source[this.offset] !== ",")
          this.fail(token === "{" ? "expected `,` or `}`" : "expected `,` or `]`", this.offset + 1);
        this.offset++;
        this.whitespace();
        if (this.source[this.offset] === close) this.fail("trailing comma", this.offset + 1);
      }
    }
    this.offset++;
    return token === "{"
      ? {
          start,
          end: this.offset,
          fields,
          duplicates,
          value: Object.fromEntries([...fields].map(([key, node]) => [key, node.value])),
        }
      : { start, end: this.offset, items, value: items.map((node) => node.value) };
  }

  private string(): void {
    this.offset++;
    for (;;) {
      const char = this.source[this.offset++];
      if (char === undefined) this.fail("EOF while parsing a string", this.source.length);
      if (char === '"') break;
      if (char === "\\") {
        const escaped = this.source[this.offset++];
        if (escaped === undefined) this.fail("EOF while parsing a string", this.source.length);
        if (escaped === "u") {
          if (!/^[\da-f]{4}$/i.test(this.source.slice(this.offset, this.offset + 4)))
            this.fail("invalid escape", Math.min(this.offset + 1, this.source.length));
          this.offset += 4;
        } else if (!'"\\/bfnrt'.includes(escaped)) this.fail("invalid escape");
      } else if (char.charCodeAt(0) < 32)
        this.fail("control character (\\u0000-\\u001F) found while parsing a string");
    }
  }

  private scalar(token: string): void {
    const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      this.source.slice(this.offset),
    );
    if (!scalar) {
      const remaining = this.source.slice(this.offset);
      if (["true", "false", "null"].some((literal) => literal.startsWith(remaining)))
        this.fail("EOF while parsing a value", this.source.length);
      this.fail("expected value", this.offset + 1);
    }
    this.offset += scalar[0].length;
    if (/[-0-9]/.test(token) && /[.eE0-9]/.test(this.source[this.offset] ?? "x")) {
      this.fail("invalid number", Math.min(this.offset + 2, this.source.length));
    }
  }
}
