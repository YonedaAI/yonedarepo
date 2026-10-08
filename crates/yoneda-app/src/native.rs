use crate::SqlStore;
use rusqlite::{Connection, types::Value as SqlValue};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};
use yoneda_core::{Error, Result};

#[derive(Clone)]
pub struct NativeStore(Rc<RefCell<Connection>>);
impl NativeStore {
    pub fn memory() -> Result<Self> {
        Ok(Self(Rc::new(RefCell::new(
            Connection::open_in_memory().map_err(db_error)?,
        ))))
    }
    pub fn open(path: &std::path::Path) -> Result<Self> {
        Ok(Self(Rc::new(RefCell::new(
            Connection::open(path).map_err(db_error)?,
        ))))
    }
}
fn db_error(e: rusqlite::Error) -> Error {
    Error::new("DATABASE", e.to_string())
}
impl SqlStore for NativeStore {
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Value>> {
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
}
