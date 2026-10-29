//! Access counters over any [`SqlStore`], for complexity gates: tests assert that what a
//! request reads scales with the request, not with the repository.
use crate::SqlStore;
use serde_json::Value;
use std::{cell::Cell, ops::Sub, rc::Rc};
use yoneda_core::Result;

/// What a store was asked for: statements run (inside transactions too), rows they
/// returned, those rows' bytes as JSON objects, and transactions begun.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SqlCounts {
    pub statements: u64,
    pub rows: u64,
    pub row_bytes: u64,
    pub transactions: u64,
}

impl Sub for SqlCounts {
    type Output = Self;
    fn sub(self, earlier: Self) -> Self {
        Self {
            statements: self.statements - earlier.statements,
            rows: self.rows - earlier.rows,
            row_bytes: self.row_bytes - earlier.row_bytes,
            transactions: self.transactions - earlier.transactions,
        }
    }
}

/// `inner`, counting every call; clones share one set of counts.
#[derive(Clone)]
pub struct Counted<S> {
    inner: S,
    counts: Rc<Cell<SqlCounts>>,
}

impl<S: SqlStore> Counted<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            counts: Rc::default(),
        }
    }

    /// The counts so far; subtract an earlier snapshot for one request's share.
    pub fn counts(&self) -> SqlCounts {
        self.counts.get()
    }

    fn add(&self, change: impl FnOnce(&mut SqlCounts)) {
        let mut counts = self.counts.get();
        change(&mut counts);
        self.counts.set(counts);
    }
}

/// Bytes `serde_json` writes for a value, without keeping them.
struct Measure(u64);
impl std::io::Write for Measure {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<S: SqlStore> SqlStore for Counted<S> {
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Value>> {
        let rows = self.inner.query(sql, params)?;
        let mut bytes = Measure(0);
        for row in &rows {
            // Writing to `Measure` cannot fail, and a row is always serializable JSON.
            let _ = serde_json::to_writer(&mut bytes, row);
        }
        self.add(|c| {
            c.statements += 1;
            c.rows += rows.len() as u64;
            c.row_bytes += bytes.0;
        });
        Ok(rows)
    }

    fn transaction(&self, action: Box<dyn FnOnce() -> Result<Value>>) -> Result<Value> {
        self.add(|c| c.transactions += 1);
        self.inner.transaction(action)
    }
}

#[cfg(all(test, feature = "native"))]
mod tests {
    use super::*;
    use crate::native::NativeStore;
    use serde_json::json;

    #[test]
    fn counts_statements_rows_and_bytes_across_clones_and_transactions() {
        let db = Counted::new(NativeStore::memory().unwrap());
        db.query("CREATE TABLE t(v TEXT)", &[]).unwrap();
        let before = db.counts();
        let inside = db.clone();
        db.transaction(Box::new(move || {
            inside.query("INSERT INTO t VALUES ('ab'),('cd')", &[])?;
            Ok(json!(null))
        }))
        .unwrap();
        let rows = db.query("SELECT v FROM t", &[]).unwrap();
        let used = db.counts() - before;
        assert_eq!(rows.len(), 2);
        // `{"v":"ab"}` and `{"v":"cd"}`
        let expected = SqlCounts {
            statements: 2,
            rows: 2,
            row_bytes: 20,
            transactions: 1,
        };
        assert_eq!(used, expected);
    }
}
