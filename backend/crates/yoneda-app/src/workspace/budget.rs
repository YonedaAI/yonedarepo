use super::*;
use crate::storage::{create, number};
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let mut budget = get(db, TABLE, "budget")
        .unwrap_or(json!({"limit":20_000_000,"charged":0,"currency":"USD","unit":"microdollar"}));
    if c["op"] == "budget_status" {
        return Ok(budget);
    }
    let id = format!("reservation:{}", string(c, "id")?);
    let amount = number(c, "amount")?;
    if !(0..=20_000_000).contains(&amount) {
        return Err(bad("Invalid reservation amount"));
    }
    if c["op"] == "budget_reserve" {
        if let Ok(existing) = get(db, TABLE, &id) {
            if existing["reserved"] != amount {
                return Err(bad("Reservation key reused for different amount"));
            }
            return Ok(existing);
        }
        let charged = number(&budget, "charged")?
            .checked_add(amount)
            .ok_or_else(|| bad("Budget overflow"))?;
        if charged > number(&budget, "limit")? {
            return Err(Error::new(
                "BUDGET_EXHAUSTED",
                "Claude testing budget exhausted; an explicit limit increase is required",
            ));
        }
        let reservation = json!({"reserved":amount,"charged":amount,"status":"reserved","at":now});
        create(db, TABLE, &id, &reservation)?;
        budget["charged"] = json!(charged);
        put(db, "budget", &budget)?;
        return Ok(reservation);
    }
    let mut reservation = get(db, TABLE, &id)?;
    if amount > number(&reservation, "reserved")? {
        return Err(bad("Settlement exceeds reserved ceiling"));
    }
    if reservation["status"] == "settled" {
        if reservation["charged"] != amount {
            return Err(bad("Settlement is immutable"));
        }
        return Ok(reservation);
    }
    budget["charged"] =
        json!(number(&budget, "charged")? - number(&reservation, "charged")? + amount);
    reservation["charged"] = json!(amount);
    reservation["status"] = json!("settled");
    put(db, "budget", &budget)?;
    put(db, &id, &reservation)?;
    Ok(reservation)
}
