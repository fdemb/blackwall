//! Issue filter clauses: `field op values`, ANDed across clauses. docs/filters.md is the contract
//! shared with the web client, which predicts the stored form and raises the same errors.

use crate::error::{Error, Result};
use chrono::{DateTime, Days, NaiveTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, de};
use utoipa::ToSchema;
use uuid::Uuid;

use super::StageKind;
use super::issues::{Issue, Priority};

pub const MAX_CLAUSES: usize = 32;
pub const MAX_VALUES: usize = 200;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterField {
    Assignee,
    CreatedBy,
    #[serde(alias = "team")]
    TeamId,
    #[serde(alias = "stage")]
    StageId,
    StageKind,
    Priority,
    #[serde(alias = "label")]
    Labels,
    #[serde(alias = "project")]
    ProjectId,
    #[serde(alias = "sprint")]
    SprintId,
    #[serde(alias = "parent")]
    ParentId,
    Dependencies,
    Estimate,
    Deadline,
    CreatedAt,
    UpdatedAt,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Is,
    IsNot,
    Lt,
    Lte,
    Gt,
    Gte,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct FilterClause {
    pub field: FilterField,
    pub op: FilterOp,
    /// Strings or null. Null stands for an empty field, or an empty set for `labels` and
    /// `dependencies`.
    pub values: Vec<Option<String>>,
}

enum Kind {
    Id,
    Stage,
    Priority,
    Number,
    Time,
}

impl FilterField {
    pub fn name(self) -> &'static str {
        match self {
            Self::Assignee => "assignee",
            Self::CreatedBy => "created_by",
            Self::TeamId => "team_id",
            Self::StageId => "stage_id",
            Self::StageKind => "stage_kind",
            Self::Priority => "priority",
            Self::Labels => "labels",
            Self::ProjectId => "project_id",
            Self::SprintId => "sprint_id",
            Self::ParentId => "parent_id",
            Self::Dependencies => "dependencies",
            Self::Estimate => "estimate",
            Self::Deadline => "deadline",
            Self::CreatedAt => "created_at",
            Self::UpdatedAt => "updated_at",
        }
    }

    fn kind(self) -> Kind {
        match self {
            Self::StageKind => Kind::Stage,
            Self::Priority => Kind::Priority,
            Self::Estimate => Kind::Number,
            Self::Deadline | Self::CreatedAt | Self::UpdatedAt => Kind::Time,
            _ => Kind::Id,
        }
    }

    /// Fields that can be empty, so `null` is a meaningful value.
    fn nullable(self) -> bool {
        matches!(
            self,
            Self::Assignee
                | Self::CreatedBy
                | Self::Labels
                | Self::ProjectId
                | Self::SprintId
                | Self::ParentId
                | Self::Dependencies
                | Self::Estimate
                | Self::Deadline
        )
    }

    fn ordered(self) -> bool {
        matches!(self.kind(), Kind::Priority | Kind::Number | Kind::Time)
    }
}

impl FilterOp {
    pub fn name(self) -> &'static str {
        match self {
            Self::Is => "is",
            Self::IsNot => "is_not",
            Self::Lt => "lt",
            Self::Lte => "lte",
            Self::Gt => "gt",
            Self::Gte => "gte",
        }
    }

    pub fn is_comparison(self) -> bool {
        !matches!(self, Self::Is | Self::IsNot)
    }

    /// The SQL operator for a comparison.
    pub fn symbol(self) -> &'static str {
        match self {
            Self::Lt => "<",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::Is => "=",
            Self::IsNot => "<>",
        }
    }
}

/// Parsed values of one clause. A comparison holds exactly one value and no null.
#[derive(Clone, Debug)]
pub enum Values {
    Ids(Vec<Uuid>),
    Kinds(Vec<StageKind>),
    Priorities(Vec<Priority>),
    Numbers(Vec<i64>),
    Times(Vec<DateTime<Utc>>),
}

#[derive(Clone, Debug)]
pub struct Compiled {
    pub field: FilterField,
    pub op: FilterOp,
    pub values: Values,
    /// Whether null was among the values.
    pub null: bool,
}

fn bad(message: String) -> Error {
    Error::BadRequest(message)
}

fn invalid(value: &str, field: FilterField) -> Error {
    bad(format!(
        "filter value {} is not valid for {}",
        serde_json::to_string(value).unwrap_or_default(),
        field.name()
    ))
}

/// `+7d`, `-30d` or `+0d`: the end of the UTC day that many days from `now`.
fn relative_day(value: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let digits = value.strip_suffix('d')?;
    let (negative, digits) = match digits.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, digits.strip_prefix('+').unwrap_or(digits)),
    };
    if digits.is_empty() || digits.len() > 5 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let days = Days::new(digits.parse().ok()?);
    let today = now.date_naive();
    let date = if negative {
        today.checked_sub_days(days)?
    } else {
        today.checked_add_days(days)?
    };
    let end = NaiveTime::from_hms_micro_opt(23, 59, 59, 999_999)?;
    Some(date.and_time(end).and_utc())
}

fn parse_time(value: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if let Some(resolved) = relative_day(value, now) {
        return Some(resolved);
    }
    let parsed: DateTime<Utc> =
        serde_json::from_value(serde_json::Value::String(value.to_owned())).ok()?;
    super::timestamp(parsed).ok()?;
    Some(parsed)
}

fn parse_priority(value: &str) -> Option<Priority> {
    serde_json::from_value(serde_json::Value::String(value.to_owned())).ok()
}

fn parse_kind(value: &str) -> Option<StageKind> {
    serde_json::from_value(serde_json::Value::String(value.to_owned())).ok()
}

fn parse_estimate(value: &str) -> Option<i64> {
    if value.is_empty() || value.len() > 10 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let number: i64 = value.parse().ok()?;
    (number <= i64::from(u32::MAX)).then_some(number)
}

impl FilterClause {
    /// Validates the clause and parses its values. Relative days resolve against `now`.
    pub fn compile(&self, now: DateTime<Utc>) -> Result<Compiled> {
        let field = self.field;
        let op = self.op;
        if self.values.is_empty() || self.values.len() > MAX_VALUES {
            return Err(bad(format!("filter clause needs 1 to {MAX_VALUES} values")));
        }
        if op.is_comparison() && !field.ordered() {
            return Err(bad(format!(
                "filter op {} does not apply to {}",
                op.name(),
                field.name()
            )));
        }
        let null = self.values.iter().any(Option::is_none);
        if op.is_comparison() && (null || self.values.len() != 1) {
            return Err(bad("filter comparison takes one non-null value".into()));
        }
        if null && !field.nullable() {
            return Err(bad(format!(
                "filter value null does not apply to {}",
                field.name()
            )));
        }
        let texts = self.values.iter().flatten().map(String::as_str);
        let values = match field.kind() {
            Kind::Id => Values::Ids(parse_all(texts, field, |v| v.parse().ok())?),
            Kind::Stage => Values::Kinds(parse_all(texts, field, parse_kind)?),
            Kind::Priority => Values::Priorities(parse_all(texts, field, parse_priority)?),
            Kind::Number => Values::Numbers(parse_all(texts, field, parse_estimate)?),
            Kind::Time => Values::Times(parse_all(texts, field, |v| parse_time(v, now))?),
        };
        Ok(Compiled {
            field,
            op,
            values,
            null,
        })
    }
}

fn parse_all<'a, T>(
    texts: impl Iterator<Item = &'a str>,
    field: FilterField,
    parse: impl Fn(&str) -> Option<T>,
) -> Result<Vec<T>> {
    texts
        .map(|text| parse(text).ok_or_else(|| invalid(text, field)))
        .collect()
}

/// Validates and parses a whole `where` list.
pub fn compile(clauses: &[FilterClause], now: DateTime<Utc>) -> Result<Vec<Compiled>> {
    if clauses.len() > MAX_CLAUSES {
        return Err(bad(format!("filter has at most {MAX_CLAUSES} clauses")));
    }
    clauses.iter().map(|clause| clause.compile(now)).collect()
}

fn member<T: PartialEq>(actual: Option<T>, wanted: &[T], null: bool) -> bool {
    match actual {
        None => null,
        Some(actual) => wanted.contains(&actual),
    }
}

fn overlaps<T: PartialEq>(actual: &[T], wanted: &[T], null: bool) -> bool {
    if actual.is_empty() {
        null
    } else {
        actual.iter().any(|item| wanted.contains(item))
    }
}

fn ordered<T: PartialOrd>(actual: Option<T>, bound: &T, op: FilterOp) -> bool {
    actual.is_some_and(|actual| match op {
        FilterOp::Lt => actual < *bound,
        FilterOp::Lte => actual <= *bound,
        FilterOp::Gt => actual > *bound,
        FilterOp::Gte => actual >= *bound,
        FilterOp::Is => actual == *bound,
        FilterOp::IsNot => actual != *bound,
    })
}

impl Compiled {
    fn test<T: PartialOrd>(&self, actual: Option<T>, wanted: &[T]) -> bool {
        if self.op.is_comparison() {
            ordered(actual, &wanted[0], self.op)
        } else {
            member(actual, wanted, self.null)
        }
    }

    /// Whether the issue satisfies this clause. `kind_of` resolves a stage id to its kind.
    pub fn matches(&self, issue: &Issue, kind_of: impl Fn(Uuid) -> Option<StageKind>) -> bool {
        use FilterField as F;
        let hit = match &self.values {
            Values::Ids(ids) => match self.field {
                F::Assignee => member(issue.assignee, ids, self.null),
                F::CreatedBy => member(issue.created_by, ids, self.null),
                F::TeamId => member(Some(issue.team_id), ids, self.null),
                F::StageId => member(Some(issue.stage_id), ids, self.null),
                F::ProjectId => member(issue.project_id, ids, self.null),
                F::SprintId => member(issue.sprint_id, ids, self.null),
                F::ParentId => member(issue.parent_id, ids, self.null),
                F::Labels => overlaps(&issue.labels, ids, self.null),
                F::Dependencies => overlaps(&issue.dependencies, ids, self.null),
                _ => false,
            },
            Values::Kinds(kinds) => member(kind_of(issue.stage_id), kinds, false),
            Values::Priorities(priorities) => self.test(Some(issue.priority.clone()), priorities),
            Values::Numbers(numbers) => self.test(issue.estimate.map(i64::from), numbers),
            Values::Times(times) => {
                let actual = match self.field {
                    F::Deadline => issue.deadline,
                    F::CreatedAt => Some(issue.created_at),
                    _ => Some(issue.updated_at),
                };
                self.test(actual, times)
            }
        };
        if self.op == FilterOp::IsNot {
            !hit
        } else {
            hit
        }
    }
}

/// `where` arrives as a JSON array in command bodies and as that array's text in a query string.
pub fn deserialize_where<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<FilterClause>, D::Error> {
    struct Where;
    impl<'de> de::Visitor<'de> for Where {
        type Value = Vec<FilterClause>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a list of filter clauses or its JSON text")
        }
        fn visit_str<E: de::Error>(self, text: &str) -> std::result::Result<Self::Value, E> {
            serde_json::from_str(text).map_err(E::custom)
        }
        fn visit_seq<A: de::SeqAccess<'de>>(
            self,
            seq: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            Deserialize::deserialize(de::value::SeqAccessDeserializer::new(seq))
        }
    }
    deserializer.deserialize_any(Where)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn clause(field: FilterField, op: FilterOp, values: &[Option<&str>]) -> FilterClause {
        FilterClause {
            field,
            op,
            values: values.iter().map(|v| v.map(str::to_owned)).collect(),
        }
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 13, 10, 30, 0).unwrap()
    }

    #[test]
    fn relative_days_resolve_to_the_end_of_the_utc_day() {
        let end = |day: u32| Utc.with_ymd_and_hms(2026, 10, day, 23, 59, 59).unwrap();
        for (value, expected) in [("+0d", 13), ("0d", 13), ("+7d", 20), ("-3d", 10)] {
            let resolved = relative_day(value, now()).unwrap();
            assert_eq!(resolved.timestamp(), end(expected).timestamp(), "{value}");
            assert_eq!(resolved.timestamp_subsec_micros(), 999_999);
        }
        for value in ["7", "d", "+d", "1w", "+123456d", "1.5d", " 1d"] {
            assert!(relative_day(value, now()).is_none(), "{value}");
        }
    }

    #[test]
    fn rejects_bad_ops_nulls_and_values() {
        let errors = [
            (
                clause(FilterField::Assignee, FilterOp::Lt, &[Some("x")]),
                "filter op lt does not apply to assignee",
            ),
            (
                clause(
                    FilterField::Priority,
                    FilterOp::Gte,
                    &[Some("high"), Some("low")],
                ),
                "filter comparison takes one non-null value",
            ),
            (
                clause(FilterField::Deadline, FilterOp::Lt, &[None]),
                "filter comparison takes one non-null value",
            ),
            (
                clause(FilterField::TeamId, FilterOp::Is, &[None]),
                "filter value null does not apply to team_id",
            ),
            (
                clause(FilterField::Priority, FilterOp::Is, &[Some("Urgent")]),
                "filter value \"Urgent\" is not valid for priority",
            ),
            (
                clause(FilterField::Estimate, FilterOp::Is, &[Some("-1")]),
                "filter value \"-1\" is not valid for estimate",
            ),
            (
                clause(FilterField::Estimate, FilterOp::Is, &[Some("4294967296")]),
                "filter value \"4294967296\" is not valid for estimate",
            ),
            (
                clause(FilterField::Deadline, FilterOp::Lte, &[Some("tomorrow")]),
                "filter value \"tomorrow\" is not valid for deadline",
            ),
            (
                clause(
                    FilterField::Deadline,
                    FilterOp::Lte,
                    &[Some("+99999-01-01T00:00:00Z")],
                ),
                "filter value \"+99999-01-01T00:00:00Z\" is not valid for deadline",
            ),
            (
                clause(FilterField::Assignee, FilterOp::Is, &[]),
                "filter clause needs 1 to 200 values",
            ),
        ];
        for (clause, message) in errors {
            match clause.compile(now()) {
                Err(Error::BadRequest(actual)) => assert_eq!(actual, message),
                other => panic!("{clause:?} gave {other:?}"),
            }
        }
        let many: Vec<_> = (0..=MAX_CLAUSES)
            .map(|_| clause(FilterField::Priority, FilterOp::Is, &[Some("high")]))
            .collect();
        assert!(
            matches!(compile(&many, now()), Err(Error::BadRequest(m)) if m == "filter has at most 32 clauses")
        );
    }

    #[test]
    fn where_accepts_json_text_and_arrays_but_not_null() {
        #[derive(Deserialize)]
        struct Holder {
            #[serde(default, deserialize_with = "deserialize_where")]
            clauses: Vec<FilterClause>,
        }
        let text = r#"[{"field":"priority","op":"is","values":["high",null]}]"#;
        let from_query: Holder = serde_urlencoded::from_str(&format!("clauses={text}")).unwrap();
        let from_json: Holder = serde_json::from_str(&format!(r#"{{"clauses":{text}}}"#)).unwrap();
        assert_eq!(from_query.clauses, from_json.clauses);
        assert_eq!(
            from_json.clauses[0].values,
            vec![Some("high".to_owned()), None]
        );
        assert!(serde_json::from_str::<Holder>(r#"{"clauses":null}"#).is_err());
        assert!(
            serde_json::from_str::<Holder>(r#"{}"#)
                .unwrap()
                .clauses
                .is_empty()
        );
    }
}
