//! Serves the compiled React Router frontend (`web/build/client`).
//!
//! The SPA shell contains a few inline bootstrap scripts. Instead of allowing
//! `unsafe-inline`, the server hashes each one at startup and puts the hashes
//! in the page's Content-Security-Policy.

use axum::{
    Router,
    extract::Request,
    http::{HeaderValue, StatusCode, Uri, header},
    middleware::{Next, from_fn},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use tower_http::services::ServeDir;

struct Shell {
    html: String,
    csp: HeaderValue,
}

fn inline_script_hashes(html: &str) -> Vec<String> {
    let mut hashes = Vec::new();
    let mut rest = html;

    while let Some(start) = rest.find("<script") {
        let after = &rest[start..];
        let Some(open_end) = after.find('>') else {
            break;
        };

        let tag = &after[..open_end];
        let body = &after[open_end + 1..];
        let Some(close) = body.find("</script>") else {
            break;
        };

        if !tag.contains(" src=") {
            let digest = Sha256::digest(&body.as_bytes()[..close]);
            hashes.push(format!("'sha256-{}'", STANDARD.encode(digest)));
        }

        rest = &body[close + "</script>".len()..];
    }

    hashes
}

fn load_shell(dir: &std::path::Path) -> Option<Shell> {
    let html = std::fs::read_to_string(dir.join("index.html")).ok()?;
    let scripts = inline_script_hashes(&html).join(" ");
    let csp = format!(
        // React Aria injects a fixed pressable touch-action stylesheet. Allow its hash,
        // not arbitrary inline styles. Vite embeds small local font files as data URLs.
        "default-src 'self'; script-src 'self' {scripts}; \
         style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='; \
         img-src 'self' https:; font-src 'self' data:; connect-src 'self'; \
         frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );

    Some(Shell {
        html,
        csp: HeaderValue::from_str(&csp).ok()?,
    })
}

pub fn default_dir() -> PathBuf {
    PathBuf::from(std::env::var("WEB_DIR").unwrap_or_else(|_| "web/build/client".into()))
}

pub fn service(dir: PathBuf) -> Router {
    let shell = load_shell(&dir).map(Arc::new);

    if shell.is_none() {
        tracing::warn!(dir = %dir.display(), "frontend build not found; run `npm run build` in web/");
    }

    let fallback = Router::new().fallback(move |uri: Uri| {
        let shell = shell.clone();
        async move { shell_response(shell, uri) }
    });

    Router::new()
        .nest_service("/assets", ServeDir::new(dir.join("assets")))
        .layer(from_fn(asset_cache))
        .fallback_service(
            ServeDir::new(dir)
                .append_index_html_on_directories(false)
                .fallback(fallback),
        )
}

/// A content-hashed asset never changes, so a browser can keep it without revalidating.
/// Anything else under `/assets` could be rewritten in place by a deploy.
async fn asset_cache(request: Request, next: Next) -> Response {
    let policy = if content_hashed(request.uri().path()) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = next.run(request).await;
    if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
    }
    response
}

/// Vite names build output `name-HASH.ext`, where HASH is 8 base64url characters.
fn content_hashed(path: &str) -> bool {
    let file = path.rsplit('/').next().unwrap_or(path);
    let Some((stem, _)) = file.rsplit_once('.') else {
        return false;
    };
    let bytes = stem.as_bytes();
    bytes.len() > 9
        && bytes[bytes.len() - 9] == b'-'
        && bytes[bytes.len() - 8..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn shell_response(shell: Option<Arc<Shell>>, uri: Uri) -> Response {
    let path = uri.path();

    if ["/api/", "/internal-api/", "/mcp"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
        || path.contains('.')
    {
        return StatusCode::NOT_FOUND.into_response();
    }

    match shell {
        Some(shell) => (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/html; charset=utf-8"),
                ),
                (header::CONTENT_SECURITY_POLICY, shell.csp.clone()),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            ],
            shell.html.clone(),
        )
            .into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Frontend not built. Run `npm install && npm run build` in web/.",
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::{content_hashed, inline_script_hashes};

    #[test]
    fn hashes_only_inline_scripts() {
        let html = r#"<script src="/a.js"></script><script>let a=1</script><script type="module" async>import "/x.js"</script>"#;

        assert_eq!(inline_script_hashes(html).len(), 2);
    }

    #[test]
    fn recognizes_vite_content_hashes() {
        for path in [
            "/issue-B1x9Qz7k.js",
            "/account-client-loader-C8YeX1nN.js",
            "/root-a_b-C9d0.css",
        ] {
            assert!(content_hashed(path), "{path}");
        }
        for path in [
            "/sw.js",
            "/issue-B1x9.js",
            "/issue-route-module.js",
            "/fonts/inter.woff2",
            "/B1x9Qz7k",
        ] {
            assert!(!content_hashed(path), "{path}");
        }
    }
}
