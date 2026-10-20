//! The plan DAG (paper §3.3), kept separate from the program graph. Proposed work items
//! whose symbols share a reference cycle that one of them writes become one joint item
//! (Tarjan SCCs over the symbol graph). Items then run in the same stage only when Eq. 1
//! holds both ways; an item that reads what another writes is ordered after it. The
//! platform plans; it never runs the work.
use super::access::{Access, AccessSet, independent};
use super::overlaps;
use super::scc::tarjan;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkItem {
    pub id: String,
    /// The snapshot the item's sets were taken at; older than the plan's means stale
    /// reads are checked against the log in between.
    #[serde(default)]
    pub base_version: Option<u64>,
    #[serde(default)]
    pub read_set: Vec<String>,
    #[serde(default)]
    pub write_set: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolNode {
    pub path: String,
    pub symbol: String,
}

/// Symbols at the plan revision and which ones each references.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SymbolGraph {
    pub nodes: Vec<SymbolNode>,
    /// `edges[i]`: the nodes node `i` references.
    pub edges: Vec<Vec<usize>>,
    /// Files whose symbols are unknown (unparsed, unsupported or outside the graph):
    /// entries on them are planned at path level.
    pub coarse: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlannedItem {
    /// Ids of the proposed items merged into this one, in input order.
    pub members: Vec<String>,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    /// Symbols the item's symbols reference (to the closure depth), added to its reads.
    pub closure: Vec<String>,
    pub stage: usize,
    /// Items that must land first (Eq. 1 fails between them).
    pub after: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub items: Vec<PlannedItem>,
    /// Item indexes per stage; items in one stage are pairwise independent.
    pub stages: Vec<Vec<usize>>,
    /// Reference cycles that joined items, as `path#symbol` entries.
    pub cycles: Vec<Vec<String>>,
}

struct Nodes<'g> {
    graph: &'g SymbolGraph,
    by_path: BTreeMap<&'g str, Vec<usize>>,
}

impl<'g> Nodes<'g> {
    fn new(graph: &'g SymbolGraph) -> Self {
        let mut by_path: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        for (i, node) in graph.nodes.iter().enumerate() {
            by_path.entry(&node.path).or_default().push(i);
        }
        Self { graph, by_path }
    }

    /// Nodes an entry covers: every symbol of a covered path, or a symbol and its members.
    fn covered(&self, set: &AccessSet) -> BTreeSet<usize> {
        let mut out = BTreeSet::new();
        for access in set.iter() {
            match access {
                Access::Path(prefix) => {
                    for (_, nodes) in self.by_path.iter().filter(|(p, _)| overlaps(prefix, p)) {
                        out.extend(nodes);
                    }
                }
                Access::Symbol { path, symbol } => {
                    let member = format!("{symbol}::");
                    out.extend(
                        self.by_path
                            .get(path.as_str())
                            .into_iter()
                            .flatten()
                            .filter(|&&i| {
                                let s = &self.graph.nodes[i].symbol;
                                s == symbol || s.starts_with(&member)
                            }),
                    );
                }
            }
        }
        out
    }

    fn entry(&self, node: usize) -> Access {
        let n = &self.graph.nodes[node];
        Access::Symbol {
            path: n.path.clone(),
            symbol: n.symbol.clone(),
        }
    }
}

fn find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    x
}

struct Joint {
    members: Vec<usize>,
    reads: AccessSet,
    writes: AccessSet,
}

/// Merges items that share a written reference cycle; returns the joint items (ordered
/// by first member) and the cycles that caused a merge.
fn join(
    nodes: &Nodes,
    reads: &[AccessSet],
    writes: &[AccessSet],
) -> (Vec<Joint>, Vec<Vec<String>>) {
    let graph = nodes.graph;
    let n = reads.len();
    let written: Vec<BTreeSet<usize>> = writes.iter().map(|w| nodes.covered(w)).collect();
    let touched: Vec<BTreeSet<usize>> = (0..n)
        .map(|i| &written[i] | &nodes.covered(&reads[i]))
        .collect();
    let mut parent: Vec<usize> = (0..n).collect();
    let mut cycles = Vec::new();
    for component in tarjan(&graph.edges).into_iter().filter(|c| c.len() > 1) {
        let hits = |sets: &[BTreeSet<usize>]| -> Vec<usize> {
            (0..n)
                .filter(|&i| component.iter().any(|v| sets[i].contains(v)))
                .collect()
        };
        let touching = hits(&touched);
        if hits(&written).is_empty() || touching.len() < 2 {
            continue;
        }
        for pair in touching.windows(2) {
            let (a, b) = (find(&mut parent, pair[0]), find(&mut parent, pair[1]));
            parent[a.max(b)] = a.min(b);
        }
        let mut names: Vec<String> = component
            .iter()
            .map(|&v| nodes.entry(v).to_string())
            .collect();
        names.sort();
        cycles.push(names);
    }
    cycles.sort();
    let mut groups: BTreeMap<usize, Joint> = BTreeMap::new();
    for i in 0..n {
        let root = find(&mut parent, i);
        let joint = groups.entry(root).or_insert_with(|| Joint {
            members: Vec::new(),
            reads: AccessSet::default(),
            writes: AccessSet::default(),
        });
        joint.members.push(i);
        joint.reads.extend(&reads[i]);
        joint.writes.extend(&writes[i]);
    }
    // Roots are the smallest member, so map order is first-member order.
    (groups.into_values().collect(), cycles)
}

/// Symbols reachable from the item's symbols within `depth` reference steps.
fn closure(nodes: &Nodes, joint: &Joint, depth: usize) -> AccessSet {
    let start = &nodes.covered(&joint.reads) | &nodes.covered(&joint.writes);
    let mut seen = start.clone();
    let mut frontier: Vec<usize> = start.into_iter().collect();
    let mut added = AccessSet::default();
    for _ in 0..depth {
        let mut next = Vec::new();
        for v in frontier {
            for &w in nodes.graph.edges[v]
                .iter()
                .filter(|&&w| w < nodes.graph.nodes.len())
            {
                if seen.insert(w) {
                    added.insert(nodes.entry(w));
                    next.push(w);
                }
            }
        }
        frontier = next;
    }
    added
}

/// Item order: an item that reads what another writes comes after it (topological over
/// the condensation of that relation, Tarjan again), ties by input position.
fn order(joints: &[Joint], reads: &[AccessSet]) -> Vec<usize> {
    let n = joints.len();
    let feeds: Vec<Vec<usize>> = (0..n)
        .map(|k| {
            (0..n)
                .filter(|&l| l != k && joints[k].writes.meets(&reads[l]))
                .collect()
        })
        .collect();
    let components = tarjan(&feeds);
    let mut component_of = vec![0; n];
    for (c, members) in components.iter().enumerate() {
        for &v in members {
            component_of[v] = c;
        }
    }
    let mut indegree = vec![0usize; components.len()];
    let mut successors: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); components.len()];
    for (k, targets) in feeds.iter().enumerate() {
        for &l in targets {
            let (a, b) = (component_of[k], component_of[l]);
            if a != b && successors[a].insert(b) {
                indegree[b] += 1;
            }
        }
    }
    let mut ready: BinaryHeap<Reverse<(usize, usize)>> = (0..components.len())
        .filter(|&c| indegree[c] == 0)
        .map(|c| Reverse((components[c][0], c)))
        .collect();
    let mut out = Vec::with_capacity(n);
    while let Some(Reverse((_, c))) = ready.pop() {
        out.extend(&components[c]);
        for &d in &successors[c] {
            indegree[d] -= 1;
            if indegree[d] == 0 {
                ready.push(Reverse((components[d][0], d)));
            }
        }
    }
    out
}

pub fn plan(items: &[WorkItem], graph: &SymbolGraph, closure_depth: usize) -> Plan {
    let nodes = Nodes::new(graph);
    let parse = |entries: &[String]| AccessSet::parse(entries).coarsen(&graph.coarse);
    let reads: Vec<AccessSet> = items.iter().map(|i| parse(&i.read_set)).collect();
    let writes: Vec<AccessSet> = items.iter().map(|i| parse(&i.write_set)).collect();
    let (joints, cycles) = join(&nodes, &reads, &writes);
    let closures: Vec<AccessSet> = joints
        .iter()
        .map(|j| closure(&nodes, j, closure_depth))
        .collect();
    let effective: Vec<AccessSet> = joints
        .iter()
        .zip(&closures)
        .map(|(j, c)| {
            let mut r = j.reads.clone();
            r.extend(c);
            r
        })
        .collect();
    let mut stage = vec![0usize; joints.len()];
    let mut after = vec![Vec::new(); joints.len()];
    let sequence = order(&joints, &effective);
    for (position, &l) in sequence.iter().enumerate() {
        for &k in &sequence[..position] {
            if !independent(
                &effective[k],
                &joints[k].writes,
                &effective[l],
                &joints[l].writes,
            ) {
                stage[l] = stage[l].max(stage[k] + 1);
                after[l].push(k);
            }
        }
        after[l].sort_unstable();
    }
    let mut stages = vec![Vec::new(); stage.iter().max().map_or(0, |s| s + 1)];
    for (k, &s) in stage.iter().enumerate() {
        stages[s].push(k);
    }
    let planned = joints
        .iter()
        .enumerate()
        .map(|(k, j)| PlannedItem {
            members: j.members.iter().map(|&i| items[i].id.clone()).collect(),
            read_set: j.reads.entries(),
            write_set: j.writes.entries(),
            closure: closures[k].entries(),
            stage: stage[k],
            after: after[k].clone(),
        })
        .collect();
    Plan {
        items: planned,
        stages,
        cycles,
    }
}

#[cfg(test)]
mod tests;
