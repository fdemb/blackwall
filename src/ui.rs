use askama::Template;
use axum::{
    http::header,
    response::{Html, IntoResponse},
};

#[derive(Template)]
#[template(path = "index.html")]
struct Index;

pub async fn index() -> Html<String> {
    Html(Index.render().expect("static application template"))
}

pub async fn js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../static/app.js"),
    )
}

pub async fn css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../static/style.css"),
    )
}
