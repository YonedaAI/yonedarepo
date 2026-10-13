// Hand-authored oracle calibration controls, never agent-produced campaign evidence.
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Reference control source anchor changed');
  return source.replace(before, after);
}
export function reference(source, stage) {
  if (stage === 'initial_build') return source;
  if (!['waitlist_feature','duplicate_registration_bugfix'].includes(stage)) throw new Error('Unknown stage');
  source = replace(source,
    "if (event.confirmed >= event.capacity) throw Object.assign(new Error('event_full'), {status:409});",
    "const status = event.confirmed >= event.capacity ? 'waitlisted' : 'confirmed';");
  source = replace(source,
    'this.sql.exec("INSERT INTO registrations(event_id,name,email,idempotency_key,status) VALUES(?,?,?,?,\'confirmed\')",\n        eventId,person.name,person.email,key);',
    'this.sql.exec("INSERT INTO registrations(event_id,name,email,idempotency_key,status) VALUES(?,?,?,?,?)",\n        eventId,person.name,person.email,key,status);');
  source = replace(source,
    'return this.registration(old.id);',
    `if (old.status === 'confirmed') {
        const waiter = this.rows("SELECT id FROM registrations WHERE event_id=? AND status='waitlisted' ORDER BY id LIMIT 1",old.event_id)[0];
        if (waiter) this.sql.exec("UPDATE registrations SET status='confirmed' WHERE id=?",waiter.id);
      }
      return this.registration(old.id);`);
  if (stage === 'duplicate_registration_bugfix') {
    source = replace(source,
      'const event = this.events().find(event => event.id === eventId);',
      `const keyRow = this.rows('SELECT id,event_id,email FROM registrations WHERE idempotency_key=? ORDER BY id LIMIT 1',key)[0];
      if (keyRow && (keyRow.event_id !== eventId || keyRow.email !== person.email)) throw Object.assign(new Error('idempotency_key_reused'),{status:409});
      const existing = keyRow ?? this.rows("SELECT id FROM registrations WHERE event_id=? AND email=? AND status!='cancelled' ORDER BY id LIMIT 1",eventId,person.email)[0];
      if (existing) return {created:false,registration:this.registration(existing.id)};
      const event = this.events().find(event => event.id === eventId);`);
  }
  return source;
}
