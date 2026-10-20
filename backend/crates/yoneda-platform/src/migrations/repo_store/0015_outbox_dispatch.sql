-- When a projector job was last asked to drain the object outbox, cleared by the job when
-- it finds the outbox empty, so a burst of staged commits sends one queue message.
CREATE TABLE object_outbox_dispatch(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dispatched_at INTEGER NOT NULL
)
