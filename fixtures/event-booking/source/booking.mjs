export class Booking {
  constructor(sql, transaction) { this.sql = sql; this.transaction = transaction; }
  rows(query, ...args) { return [...this.sql.exec(query, ...args)]; }
  events() {
    return this.rows(`SELECT e.id,e.title,e.capacity,
      (SELECT count(*) FROM registrations r WHERE r.event_id=e.id AND r.status='confirmed') AS confirmed,
      (SELECT count(*) FROM registrations r WHERE r.event_id=e.id AND r.status='waitlisted') AS waitlisted
      FROM events e ORDER BY e.id`);
  }
  registration(id) {
    const row = this.rows('SELECT id,event_id,status FROM registrations WHERE id=?', id)[0];
    if (!row) throw Object.assign(new Error('registration_not_found'), {status:404});
    const ahead = row.status === 'waitlisted' ? this.rows(
      "SELECT count(*) AS n FROM registrations WHERE event_id=? AND status='waitlisted' AND id<=?", row.event_id,id)[0].n : null;
    return {...row, position:ahead};
  }
  register(eventId, person, key) {
    return this.transaction(() => {
      const event = this.events().find(event => event.id === eventId);
      if (!event) throw Object.assign(new Error('event_not_found'), {status:404});
      if (event.confirmed >= event.capacity) throw Object.assign(new Error('event_full'), {status:409});
      this.sql.exec("INSERT INTO registrations(event_id,name,email,idempotency_key,status) VALUES(?,?,?,?,'confirmed')",
        eventId,person.name,person.email,key);
      const id = this.rows('SELECT last_insert_rowid() AS id')[0].id;
      return {created:true, registration:this.registration(id)};
    });
  }
  cancel(id) {
    return this.transaction(() => {
      const old = this.registration(id);
      this.sql.exec("UPDATE registrations SET status='cancelled' WHERE id=?", id);
      return this.registration(old.id);
    });
  }
}
