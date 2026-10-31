//! Serves the compiled React Router frontend (`web/build/client`).
//!
//! The SPA shell contains a few inline bootstrap scripts. Instead of allowing
//! `unsafe-inline`, the server hashes each one at startup and puts the hashes
//! in the page's Content-Security-Policy.

use axum::{
    Router,
    http::{HeaderValue, StatusCode, Uri, header},
    middleware::map_response,
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
        .layer(map_response(cache_forever))
        .fallback_service(
            ServeDir::new(dir)
                .append_index_html_on_directories(false)
                .fallback(fallback),
        )
}

/// Build assets carry a content hash in their names, so a browser never needs to revalidate one.
async fn cache_forever(mut response: Response) -> Response {
    if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    response
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
                // A deploy replaces the asset names the shell points at.
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
    use super::{inline_script_hashes, service};
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[test]
    fn hashes_only_inline_scripts() {
        let html = r#"<script src="/a.js"></script><script>let a=1</script><script type="module" async>import "/x.js"</script>"#;

        assert_eq!(inline_script_hashes(html).len(), 2);
    }

    #[tokio::test]
    async fn hashed_assets_are_cached_forever_and_the_shell_revalidates() {
        let dir = std::env::temp_dir().join(format!("blackwall-web-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<!DOCTYPE html>").unwrap();
        std::fs::write(dir.join("theme.js"), "").unwrap();
        std::fs::write(dir.join("assets/issue-B1x9.js"), "export {}").unwrap();
        let app = service(dir.clone());

        let mut seen = Vec::new();
        for path in [
            "/assets/issue-B1x9.js",
            "/assets/missing-C2y8.js",
            "/team/ENG",
            "/theme.js",
        ] {
            let request = Request::builder().uri(path).body(Body::empty()).unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            let cache = response
                .headers()
                .get("cache-control")
                .map(|value| value.to_str().unwrap().to_owned());
            seen.push((path, response.status().as_u16(), cache));
        }
        std::fs::remove_dir_all(dir).unwrap();

        assert_eq!(
            seen,
            [
                (
                    "/assets/issue-B1x9.js",
                    200,
                    Some("public, max-age=31536000, immutable".to_owned())
                ),
                ("/assets/missing-C2y8.js", 404, None),
                ("/team/ENG", 200, Some("no-cache".to_owned())),
                ("/theme.js", 200, None),
            ]
        );
    }
}
