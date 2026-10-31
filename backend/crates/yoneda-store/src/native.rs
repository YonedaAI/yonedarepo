use crate::SqlStore;
use rusqlite::{Connection, limits::Limit, types::Value as SqlValue};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};
use yoneda_core::{Error, Result};

#[derive(Clone)]
pub struct NativeStore(Rc<RefCell<Connection>>);
impl NativeStore {
    pub fn memory() -> Result<Self> {
        Self::limited(Connection::open_in_memory().map_err(db_error)?)
    }
    pub fn open(path: &std::path::Path) -> Result<Self> {
        Self::limited(Connection::open(path).map_err(db_error)?)
    }
    /// Durable Object SQLite's bound-parameter limit, so tests fail where production would.
    fn limited(connection: Connection) -> Result<Self> {
        let limit = i32::try_from(crate::MAX_BOUND_PARAMETERS)
            .map_err(|_| Error::new("DATABASE", "Invalid parameter limit"))?;
        connection
            .set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, limit)
            .map_err(db_error)?;
        Ok(Self(Rc::new(RefCell::new(connection))))
    }
}
/// Durable Object SQLite binds at most 100 parameters per statement; the native store
/// refuses more too, so tests catch a query that only fails once deployed.
const MAX_PARAMS: usize = 100;

fn db_error(e: rusqlite::Error) -> Error {
    Error::new("DATABASE", e.to_string())
}
impl SqlStore for NativeStore {
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Value>> {
        if params.len() > MAX_PARAMS {
            return Err(Error::new(
                "DATABASE",
                format!(
                    "too many SQL variables: {} bound, at most {MAX_PARAMS}",
                    params.len()
                ),
            ));
        }
        let connection = self.0.borrow();
        let values: Vec<_> = params
            .iter()
            .map(|v| match v {
                Value::Null => SqlValue::Null,
                Value::Number(n) => SqlValue::Integer(n.as_i64().unwrap_or_default()),
                Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
                Value::String(s) => SqlValue::Text(s.clone()),
                _ => SqlValue::Text(v.to_string()),
            })
            .collect();
        let mut statement = connection.prepare(sql).map_err(db_error)?;
        let names: Vec<String> = statement
            .column_names()
            .iter()
            .map(|s| (*s).into())
            .collect();
        let mut rows = statement
            .query(rusqlite::params_from_iter(values))
            .map_err(db_error)?;
        let mut output = Vec::new();
        while let Some(row) = rows.next().map_err(db_error)? {
            let mut value = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let v = match row.get::<_, SqlValue>(i).map_err(db_error)? {
                    SqlValue::Null => Value::Null,
                    SqlValue::Integer(n) => n.into(),
                    SqlValue::Real(n) => serde_json::json!(n),
                    SqlValue::Text(s) => Value::String(s),
                    SqlValue::Blob(_) => {
                        return Err(Error::new("DATABASE", "Unexpected blob column"));
                    }
                };
                value.insert(name.clone(), v);
            }
            output.push(Value::Object(value));
        }
        Ok(output)
    }
    fn transaction(&self, action: Box<dyn FnOnce() -> Result<Value>>) -> Result<Value> {
        self.0
            .borrow()
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(db_error)?;
        match action() {
            Ok(value) => {
                self.0.borrow().execute_batch("COMMIT").map_err(db_error)?;
                Ok(value)
            }
            Err(error) => {
                self.0
                    .borrow()
                    .execute_batch("ROLLBACK")
                    .map_err(db_error)?;
                Err(error)
            }
        }
    }
    fn database_size(&self) -> Result<u64> {
        let rows = self.query(
            "SELECT page_count*page_size AS bytes FROM pragma_page_count(),pragma_page_size()",
            &[],
        )?;
        rows.first()
            .and_then(|row| row["bytes"].as_u64())
            .ok_or_else(|| Error::new("DATABASE", "SQLite reported no database size"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn binds_at_most_as_many_parameters_as_durable_object_sqlite() {
        let db = NativeStore::memory().unwrap();
        let bind = |n: usize| {
            let marks = vec!["?"; n].join(",");
            let params: Vec<Value> = (0..n).map(|i| json!(i)).collect();
            db.query(&format!("SELECT 1 WHERE 0 IN ({marks})"), &params)
        };
        assert_eq!(bind(crate::MAX_BOUND_PARAMETERS).unwrap().len(), 1);
        let refused = bind(crate::MAX_BOUND_PARAMETERS + 1).unwrap_err();
        assert!(
            refused.message.contains("too many SQL variables"),
            "{}",
            refused.message
        );
    }

    #[test]
    fn database_size_grows_with_the_pages_in_use() {
        let db = NativeStore::memory().unwrap();
        let empty = db.database_size().unwrap();
        db.query("CREATE TABLE t(v TEXT)", &[]).unwrap();
        db.query("INSERT INTO t VALUES(?)", &[json!("x".repeat(100_000))])
            .unwrap();
        assert!(db.database_size().unwrap() >= empty + 100_000);
    }
}
