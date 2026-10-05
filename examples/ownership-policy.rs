fn main() -> blackwall::error::Result<()> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("web/app/lib/ownership-policy.generated.json");
    std::fs::write(path, blackwall::store::ownership::frontend_policy()?)
        .map_err(|error| blackwall::error::Error::Internal(error.to_string()))
}
