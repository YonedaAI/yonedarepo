ALTER TABLE copy_identity RENAME TO copy_identity_v1;
CREATE TABLE copy_identity(
  id INTEGER PRIMARY KEY CHECK(id=1),
  repo TEXT NOT NULL,
  region TEXT NOT NULL CHECK(region IN ('enam','weur','apac','oc','sam','afr','registry')),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1))
);
INSERT INTO copy_identity SELECT id,repo,region,epoch,sealed FROM copy_identity_v1;
DROP TABLE copy_identity_v1;

ALTER TABLE copy_regions RENAME TO copy_regions_v1;
CREATE TABLE copy_regions(region TEXT PRIMARY KEY CHECK(region IN ('enam','weur','apac','oc','sam','afr')));
INSERT INTO copy_regions SELECT region FROM copy_regions_v1;
DROP TABLE copy_regions_v1;
