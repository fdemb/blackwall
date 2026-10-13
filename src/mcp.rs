//! A Model Context Protocol server at `/mcp`, using the stateless Streamable HTTP
//! transport: each POST carries one JSON-RPC message and gets one JSON reply.
//! It authenticates like `/api/v1` and its tools call the same functions, so a
//! token's access, workspace allowlist and rate limit apply unchanged.

use crate::{
    api::{
        self, ApiActor, IssueQuery, Scope, UpdateIssue, WriteOptions,
        issues::{self, CreateComment},
        resources,
    },
    domain::{IssueInput, Label, Project, Team},
    error::{Error, Result},
    store::Store,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use std::{sync::OnceLock, time::Duration};
use tower_http::cors::{AllowOrigin, CorsLayer};
use uuid::Uuid;

/// Newest first; the first is offered when the client asks for an unknown version.
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

const INSTRUCTIONS: &str = "Blackwall is a work tracker. Issues belong to a team and sit in one of \
the team's stages; keys look like BW-42 and are accepted wherever an issue is named. Call \
get_workspace_overview first to learn team, stage, label, project and member ids. When the token \
reaches a single workspace, workspace_id may be omitted.";

pub async fn handle(State(store): State<Store>, actor: ApiActor, body: Bytes) -> Response {
    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(rpc_error(Value::Null, -32700, "parse error")),
            )
                .into_response();
        }
    };
    if !message.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(rpc_error(
                Value::Null,
                -32600,
                "send one JSON-RPC message per request",
            )),
        )
            .into_response();
    }

    // Notifications and responses need no reply.
    let (Some(method), Some(id)) = (message["method"].as_str(), message.get("id").cloned()) else {
        return StatusCode::ACCEPTED.into_response();
    };
    let params = &message["params"];
    let result = match method {
        "initialize" => Ok(initialize(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools(&actor) })),
        "tools/call" => call(&store, &actor, params).await,
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Json(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => rpc_error(id, code, &message),
    })
    .into_response()
}

/// Rejects browser requests from origins outside `MCP_ALLOWED_ORIGINS`, as
/// the transport requires against DNS rebinding. Requests without an `Origin`
/// (desktop and server clients) and same-origin requests pass.
pub async fn guard_origin(request: Request, next: Next) -> Response {
    if request.headers().contains_key(header::ORIGIN) && !allowed_origin(request.headers()) {
        return Error::Denied("origin not allowed; see MCP_ALLOWED_ORIGINS".into()).into_response();
    }
    next.run(request).await
}

fn allowed_origin(headers: &HeaderMap) -> bool {
    static ALLOWED: OnceLock<Vec<String>> = OnceLock::new();
    let allowed = ALLOWED.get_or_init(|| {
        std::env::var("MCP_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|origin| origin.trim().trim_end_matches('/').to_ascii_lowercase())
            .filter(|origin| !origin.is_empty())
            .collect()
    });
    if !crate::http::cross_origin(headers) {
        return true;
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|o| o.to_str().ok())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    allowed.iter().any(|a| a == "*" || *a == origin)
}

/// CORS for the origins `guard_origin` admits; credentials are never allowed.
pub fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|_, parts| {
            allowed_origin(&parts.headers)
        }))
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            HeaderName::from_static("mcp-protocol-version"),
            HeaderName::from_static("mcp-session-id"),
            HeaderName::from_static("last-event-id"),
        ])
        .expose_headers(api::EXPOSED_HEADERS)
        .max_age(Duration::from_secs(600))
}

/// The transport's optional server-to-client stream, which this server does not offer.
pub async fn stream() -> Response {
    let mut response = StatusCode::METHOD_NOT_ALLOWED.into_response();
    response
        .headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static("POST"));
    response
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize(params: &Value) -> Value {
    let requested = params["protocolVersion"].as_str().unwrap_or_default();
    let version = PROTOCOL_VERSIONS
        .iter()
        .find(|v| **v == requested)
        .unwrap_or(&PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "blackwall", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

struct Tool {
    name: &'static str,
    description: &'static str,
    write: bool,
    schema: fn() -> Value,
}

const TOOLS: &[Tool] = &[
    Tool {
        name: "list_workspaces",
        description: "List the workspaces this token can reach, with the user's role in each.",
        write: false,
        schema: || object(json!({}), &[]),
    },
    Tool {
        name: "get_workspace_overview",
        description: "Teams with their stages, labels, projects and members of a workspace: \
            the ids other tools take.",
        write: false,
        schema: || object(json!({ "workspace_id": workspace_id() }), &[]),
    },
    Tool {
        name: "search_issues",
        description: "Find issues by text and filters. Returns compact issues without \
            descriptions; use get_issue for details.",
        write: false,
        schema: || {
            object(
                json!({
                    "workspace_id": workspace_id(),
                    "query": { "type": "string", "description": "Text, or an issue number or key." },
                    "where": {
                        "type": "array",
                        "description": "Filter clauses ANDed together. Each is {field, op, values}; \
                            fields include assignee, team_id, stage_id, stage_kind \
                            (backlog|planned|active|done|cancelled), priority, labels, project_id, \
                            deadline. ops: is, is_not, lt, lte, gt, gte. values are strings or null \
                            (null assignee means unassigned).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": { "type": "string" },
                                "op": { "type": "string" },
                                "values": { "type": "array", "items": { "type": ["string", "null"] } }
                            },
                            "required": ["field", "op", "values"]
                        }
                    },
                    "archived": { "type": "boolean", "description": "Search archived issues instead." },
                    "sort": { "type": "string", "enum": ["position", "deadline", "updated", "priority"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
                    "cursor": { "type": "string", "description": "next_cursor from a previous call." }
                }),
                &[],
            )
        },
    },
    Tool {
        name: "get_issue",
        description: "An issue with its description and its first 50 comments.",
        write: false,
        schema: || {
            object(
                json!({ "workspace_id": workspace_id(), "issue": issue_ref() }),
                &["issue"],
            )
        },
    },
    Tool {
        name: "create_issue",
        description: "Create an issue in a team. Without stage_id it lands in the team's first stage.",
        write: true,
        schema: || {
            let mut properties = issue_fields();
            properties["workspace_id"] = workspace_id();
            properties["team_id"] = json!({ "type": "string", "format": "uuid" });
            object(properties, &["team_id", "title"])
        },
    },
    Tool {
        name: "update_issue",
        description: "Change an issue's fields. Omitted fields stay; null clears assignee, \
            estimate, deadline, project_id, milestone_id, sprint_id or parent_id.",
        write: true,
        schema: || {
            let mut properties = issue_fields();
            properties["workspace_id"] = workspace_id();
            properties["issue"] = issue_ref();
            object(properties, &["issue"])
        },
    },
    Tool {
        name: "add_comment",
        description: "Comment on an issue as the token's user.",
        write: true,
        schema: || {
            object(
                json!({
                    "workspace_id": workspace_id(),
                    "issue": issue_ref(),
                    "body": { "type": "string", "description": "Markdown." }
                }),
                &["issue", "body"],
            )
        },
    },
];

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn workspace_id() -> Value {
    json!({
        "type": "string",
        "format": "uuid",
        "description": "Optional when the token reaches a single workspace."
    })
}

fn issue_ref() -> Value {
    json!({ "type": "string", "description": "Issue key such as BW-42, or its UUID." })
}

fn issue_fields() -> Value {
    let id = json!({ "type": ["string", "null"], "format": "uuid" });
    json!({
        "title": { "type": "string" },
        "description": { "type": "string", "description": "Markdown." },
        "stage_id": { "type": "string", "format": "uuid" },
        "assignee": { "type": ["string", "null"], "format": "uuid", "description": "User id." },
        "priority": { "type": "string", "enum": ["none", "low", "normal", "high", "urgent"] },
        "labels": { "type": "array", "items": { "type": "string", "format": "uuid" } },
        "estimate": { "type": ["integer", "null"], "minimum": 0 },
        "deadline": { "type": ["string", "null"], "format": "date-time" },
        "project_id": id,
        "milestone_id": id,
        "sprint_id": id,
        "parent_id": { "type": ["string", "null"], "description": "Parent issue key or UUID." }
    })
}

fn tools(actor: &ApiActor) -> Vec<Value> {
    let writable = actor.0.access == api::Access::Write;
    TOOLS
        .iter()
        .filter(|tool| writable || !tool.write)
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": (tool.schema)(),
                "annotations": {
                    "readOnlyHint": !tool.write,
                    "destructiveHint": false,
                    "openWorldHint": false
                }
            })
        })
        .collect()
}

async fn call(
    store: &Store,
    actor: &ApiActor,
    params: &Value,
) -> std::result::Result<Value, (i64, String)> {
    let name = params["name"].as_str().unwrap_or_default();
    if !TOOLS.iter().any(|tool| tool.name == name) {
        return Err((-32602, format!("unknown tool: {name}")));
    }
    let arguments = match &params["arguments"] {
        Value::Object(arguments) => arguments.clone(),
        Value::Null => Map::new(),
        _ => return Err((-32602, "arguments must be an object".into())),
    };

    // Tool failures are results the model can read and act on, not protocol errors.
    Ok(match run_tool(store, actor, name, arguments).await {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": value.to_string() }],
            "structuredContent": value,
            "isError": false
        }),
        Err(error) => {
            let message = match &error {
                Error::Database(_) | Error::Internal(_) => {
                    tracing::error!(%error, tool = name, "MCP tool failed");
                    "internal server error".to_owned()
                }
                _ => error.to_string(),
            };
            json!({ "content": [{ "type": "text", "text": message }], "isError": true })
        }
    })
}

async fn run_tool(
    store: &Store,
    actor: &ApiActor,
    name: &str,
    mut args: Map<String, Value>,
) -> Result<Value> {
    if name == "list_workspaces" {
        return Ok(json!({ "workspaces": resources::workspace_list(store, actor).await? }));
    }
    let workspace = workspace(store, actor, args.remove("workspace_id")).await?;
    let read = || actor.read(workspace);
    let write = || actor.write(workspace);

    match name {
        "get_workspace_overview" => overview(store, read()?).await,
        "search_issues" => {
            let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(25);
            if !(1..=100).contains(&limit) {
                return Err(Error::BadRequest("limit must be between 1 and 100".into()));
            }
            if let Some(query) = args.remove("query") {
                args.insert("search".into(), query);
            }
            let query: IssueQuery = from_args(args)?;
            let page = issues::search(store, read()?, query).await?;
            let compact: Vec<Value> = page.data.iter().map(compact_issue).collect();
            Ok(json!({ "issues": compact, "next_cursor": page.next_cursor }))
        }
        "get_issue" => {
            let scope = read()?;
            let id = issue_arg(store, scope, &mut args).await?;
            let issue = issues::fetch(store, scope, id).await?;
            let comments = issues::issue_comments(
                store,
                scope,
                id,
                &api::PageParams {
                    limit: Some(50),
                    cursor: None,
                },
            )
            .await?;
            Ok(json!({ "issue": issue, "comments": comments.data }))
        }
        "create_issue" => {
            let scope = write()?;
            resolve_parent(store, scope, &mut args).await?;
            let input: IssueInput = from_args(args)?;
            let issue = issues::create_issue(store, scope, input, WriteOptions::default()).await?;
            Ok(json!({ "issue": issue }))
        }
        "update_issue" => {
            let scope = write()?;
            let id = issue_arg(store, scope, &mut args).await?;
            resolve_parent(store, scope, &mut args).await?;
            let update: UpdateIssue = from_args(args)?;
            let issue =
                issues::update_issue(store, scope, id, update, WriteOptions::default()).await?;
            Ok(json!({ "issue": issue }))
        }
        "add_comment" => {
            let scope = write()?;
            let id = issue_arg(store, scope, &mut args).await?;
            let body: CreateComment = from_args(args)?;
            let comment =
                issues::add_comment(store, scope, id, body, WriteOptions::default()).await?;
            Ok(json!({ "comment": comment }))
        }
        _ => Err(Error::NotFound),
    }
}

fn from_args<T: serde::de::DeserializeOwned>(args: Map<String, Value>) -> Result<T> {
    serde_json::from_value(Value::Object(args))
        .map_err(|error| Error::BadRequest(format!("invalid arguments: {error}")))
}

/// The named workspace, or the only one the token reaches.
async fn workspace(store: &Store, actor: &ApiActor, named: Option<Value>) -> Result<Uuid> {
    if let Some(named) = named.filter(|v| !v.is_null()) {
        return named
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
            .ok_or_else(|| Error::BadRequest("workspace_id must be a UUID".into()));
    }
    let mut reachable = resources::workspace_list(store, actor).await?;
    match (reachable.pop(), reachable.is_empty()) {
        (Some(only), true) => Ok(only.id),
        (None, _) => Err(Error::BadRequest("this token reaches no workspaces".into())),
        _ => Err(Error::BadRequest(
            "workspace_id is required; call list_workspaces".into(),
        )),
    }
}

async fn issue_arg(store: &Store, scope: Scope, args: &mut Map<String, Value>) -> Result<Uuid> {
    let reference = args
        .remove("issue")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| Error::BadRequest("issue is required".into()))?;
    issues::resolve(store, scope, &reference).await
}

/// Lets models name a parent by key; the commands take its UUID.
async fn resolve_parent(store: &Store, scope: Scope, args: &mut Map<String, Value>) -> Result<()> {
    if let Some(Value::String(reference)) = args.get("parent_id") {
        let id = issues::resolve(store, scope, reference).await?;
        args.insert("parent_id".into(), json!(id));
    }
    Ok(())
}

fn compact_issue(issue: &api::ApiIssue) -> Value {
    let i = &issue.issue;
    json!({
        "key": issue.key,
        "id": i.id,
        "title": i.title,
        "team_id": i.team_id,
        "stage_id": i.stage_id,
        "assignee": i.assignee,
        "priority": i.priority,
        "labels": i.labels,
        "project_id": i.project_id,
        "parent_id": i.parent_id,
        "deadline": i.deadline,
        "archived": i.archived_at.is_some(),
        "updated_at": i.updated_at,
    })
}

async fn overview(store: &Store, scope: Scope) -> Result<Value> {
    let all = api::PageParams {
        limit: Some(200),
        cursor: None,
    };
    let teams = resources::list_collection::<Team>(store, scope, "teams", &all, None).await?;
    let labels = resources::list_collection::<Label>(store, scope, "labels", &all, None).await?;
    let projects =
        resources::list_collection::<Project>(store, scope, "projects", &all, None).await?;
    let members = resources::member_list(store, scope).await?;

    Ok(json!({
        "teams": teams.data.iter().map(|t| json!({
            "id": t.id,
            "name": t.name,
            "stages": t.stages.iter().map(|s| json!({ "id": s.id, "name": s.name, "kind": s.kind })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "labels": labels.data.iter().map(|l| json!({ "id": l.id, "name": l.name })).collect::<Vec<_>>(),
        "projects": projects.data.iter().map(|p| json!({ "id": p.id, "name": p.name, "team_ids": p.team_ids })).collect::<Vec<_>>(),
        "members": members.iter().map(|m| json!({
            "id": m.id,
            "display_name": m.display_name,
            "email": m.email,
            "role": m.role,
        })).collect::<Vec<_>>(),
    }))
}
