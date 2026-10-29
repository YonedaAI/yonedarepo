-- Branches' first-parent chains (repo_store/ref_chain.rs): path history reads a path's
-- commit_paths rows joined to the branch's chain instead of walking first parents. Filled
-- as refs move. A branch not moved since this migration has no chain and is walked.
CREATE TABLE ref_chain(
  ref TEXT NOT NULL,
  depth INTEGER NOT NULL,
  commit_id TEXT NOT NULL,
  PRIMARY KEY(ref, depth)
);
CREATE INDEX ref_chain_by_commit ON ref_chain(ref, commit_id);
