use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    BadRequest(String),
    #[error("authentication required")]
    Unauthorized,
    #[error("permission denied")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    ServiceUnavailable(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Internal(String),
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct ErrorBody {
    pub error: String,
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        if let Self::Database(sqlx::Error::Database(error)) = &self
            && error.code().as_deref() == Some("23514")
            && error.constraint() == Some(crate::store::ownership::OWNERSHIP_CONSTRAINT)
        {
            return (
                StatusCode::CONFLICT,
                Json(ErrorBody {
                    error: crate::store::ownership::OWNERSHIP_MESSAGE.into(),
                }),
            )
                .into_response();
        }
        if let Self::ServiceUnavailable(message) = self {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(axum::http::header::RETRY_AFTER, "5")],
                Json(ErrorBody { error: message }),
            )
                .into_response();
        }
        let status = match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };

        let message = if status.is_server_error() {
            tracing::error!(error = %self, "request failed");
            "internal server error".into()
        } else {
            self.to_string()
        };

        (status, Json(ErrorBody { error: message })).into_response()
    }
}
