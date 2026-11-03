CREATE TABLE copy_identity(
  id INTEGER PRIMARY KEY CHECK(id=1),
  repo TEXT NOT NULL,
  region TEXT NOT NULL CHECK(region IN ('enam','weur','registry')),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1))
);
CREATE TABLE copy_objects(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('blob','tree')),
  payload TEXT NOT NULL
);

CREATE TABLE copy_regions(region TEXT PRIMARY KEY CHECK(region IN ('enam','weur')));
CREATE TABLE copy_blocked(id TEXT PRIMARY KEY);
