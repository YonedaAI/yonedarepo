use super::*;
use proptest::prelude::*;

fn item(id: &str, reads: &[&str], writes: &[&str]) -> WorkItem {
    WorkItem {
        id: id.into(),
        base_version: None,
        read_set: reads.iter().map(|s| s.to_string()).collect(),
        write_set: writes.iter().map(|s| s.to_string()).collect(),
    }
}

/// Nodes named `path#symbol`, edges by index.
fn graph(nodes: &[&str], edges: &[(usize, usize)]) -> SymbolGraph {
    let nodes: Vec<SymbolNode> = nodes
        .iter()
        .map(|n| {
            let (path, symbol) = n.split_once('#').unwrap();
            SymbolNode {
                path: path.into(),
                symbol: symbol.into(),
            }
        })
        .collect();
    let mut adjacency = vec![Vec::new(); nodes.len()];
    for &(a, b) in edges {
        adjacency[a].push(b);
    }
    SymbolGraph {
        nodes,
        edges: adjacency,
        coarse: BTreeSet::new(),
    }
}

#[test]
fn a_written_cycle_becomes_one_joint_item() {
    // a <-> b across files; c stands alone.
    let g = graph(&["a.ts#a", "b.ts#b", "c.ts#c"], &[(0, 1), (1, 0)]);
    let items = [
        item("i1", &[], &["a.ts#a"]),
        item("i2", &[], &["b.ts#b"]),
        item("i3", &[], &["c.ts#c"]),
    ];
    let p = plan(&items, &g, 0);
    assert_eq!(p.items.len(), 2);
    assert_eq!(p.items[0].members, ["i1", "i2"]);
    assert_eq!(p.items[0].write_set, ["a.ts#a", "b.ts#b"]);
    assert_eq!(p.cycles, vec![vec!["a.ts#a".to_string(), "b.ts#b".into()]]);
    assert_eq!(p.stages, vec![vec![0, 1]]);
}

#[test]
fn readers_alone_do_not_join_a_cycle() {
    let g = graph(&["a.ts#a", "b.ts#b"], &[(0, 1), (1, 0)]);
    let items = [
        item("r1", &["a.ts#a"], &["x.ts"]),
        item("r2", &["b.ts#b"], &["y.ts"]),
    ];
    let p = plan(&items, &g, 0);
    assert_eq!(p.items.len(), 2);
    assert!(p.cycles.is_empty());
    assert_eq!(p.stages, vec![vec![0, 1]]);
}

#[test]
fn a_reader_runs_after_the_writer_it_depends_on() {
    // Listed first, but reads what the second writes: the writer goes first.
    let items = [
        item("cart", &["pricing.ts#price"], &["cart.ts"]),
        item("pricing", &[], &["pricing.ts#price"]),
    ];
    let p = plan(&items, &SymbolGraph::default(), 1);
    assert_eq!(p.items[0].stage, 1);
    assert_eq!(p.items[0].after, [1]);
    assert_eq!(p.items[1].stage, 0);
    assert_eq!(p.stages, vec![vec![1], vec![0]]);
}

#[test]
fn different_symbols_of_one_file_run_in_parallel_unless_coarse() {
    let g = graph(&["lib.rs#retry", "lib.rs#backoff"], &[]);
    let items = [
        item("a", &["lib.rs#retry"], &["lib.rs#retry"]),
        item("b", &["lib.rs#backoff"], &["lib.rs#backoff"]),
    ];
    assert_eq!(plan(&items, &g, 1).stages, vec![vec![0, 1]]);
    let mut unparsed = g.clone();
    unparsed.coarse.insert("lib.rs".into());
    let p = plan(&items, &unparsed, 1);
    assert_eq!(p.stages, vec![vec![0], vec![1]]);
    assert_eq!(p.items[1].write_set, ["lib.rs"]);
}

#[test]
fn closure_adds_referenced_symbols_to_reads() {
    // quote calls price: changing quote reads price, so it waits for price's change.
    let g = graph(&["p.ts#price", "p.ts#quote"], &[(1, 0)]);
    let items = [
        item("q", &[], &["p.ts#quote"]),
        item("p", &[], &["p.ts#price"]),
    ];
    let without = plan(&items, &g, 0);
    assert_eq!(without.stages, vec![vec![0, 1]]);
    let with = plan(&items, &g, 1);
    assert_eq!(with.items[0].closure, ["p.ts#price"]);
    assert_eq!(with.stages, vec![vec![1], vec![0]]);
}

#[test]
fn a_whole_file_entry_covers_its_symbols_in_cycles() {
    let g = graph(&["a.rs#f", "a.rs#g"], &[(0, 1), (1, 0)]);
    let items = [item("x", &[], &["a.rs"]), item("y", &["a.rs#g"], &["z.rs"])];
    let p = plan(&items, &g, 0);
    assert_eq!(p.items.len(), 1);
    assert_eq!(p.items[0].members, ["x", "y"]);
}

fn entry_strategy() -> impl Strategy<Value = String> {
    (0usize..3, prop::option::of(0usize..3)).prop_map(|(file, symbol)| match symbol {
        Some(s) => format!("f{file}.rs#s{s}"),
        None => format!("f{file}.rs"),
    })
}

proptest! {
    #[test]
    fn eq1_is_symmetric(
        ra in prop::collection::vec(entry_strategy(), 0..4),
        wa in prop::collection::vec(entry_strategy(), 0..4),
        rb in prop::collection::vec(entry_strategy(), 0..4),
        wb in prop::collection::vec(entry_strategy(), 0..4),
    ) {
        let (ra, wa, rb, wb) = (
            AccessSet::parse(&ra), AccessSet::parse(&wa), AccessSet::parse(&rb), AccessSet::parse(&wb),
        );
        prop_assert_eq!(independent(&ra, &wa, &rb, &wb), independent(&rb, &wb, &ra, &wa));
    }

    #[test]
    fn stages_hold_only_independent_items(
        items in prop::collection::vec(
            (prop::collection::vec(entry_strategy(), 0..3), prop::collection::vec(entry_strategy(), 0..3)),
            1..8,
        ),
        pairs in prop::collection::vec((0usize..9, 0usize..9), 0..12),
        depth in 0usize..3,
    ) {
        let names: Vec<String> = (0..3)
            .flat_map(|f| (0..3).map(move |s| format!("f{f}.rs#s{s}")))
            .collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let g = graph(&refs, &pairs);
        let work: Vec<WorkItem> = items
            .iter()
            .enumerate()
            .map(|(i, (r, w))| WorkItem { id: format!("i{i}"), base_version: None, read_set: r.clone(), write_set: w.clone() })
            .collect();
        let p = plan(&work, &g, depth);
        let mut members: Vec<String> = p.items.iter().flat_map(|i| i.members.clone()).collect();
        members.sort();
        let mut ids: Vec<String> = work.iter().map(|w| w.id.clone()).collect();
        ids.sort();
        prop_assert_eq!(members, ids);
        let sets: Vec<(AccessSet, AccessSet)> = p.items.iter().map(|i| {
            let mut reads = AccessSet::parse(&i.read_set);
            reads.extend(&AccessSet::parse(&i.closure));
            (reads, AccessSet::parse(&i.write_set))
        }).collect();
        for (k, a) in p.items.iter().enumerate() {
            prop_assert!(p.stages[a.stage].contains(&k));
            for &before in &a.after {
                prop_assert!(p.items[before].stage < a.stage);
            }
            for (l, b) in p.items.iter().enumerate().skip(k + 1) {
                let free = independent(&sets[k].0, &sets[k].1, &sets[l].0, &sets[l].1);
                if a.stage == b.stage {
                    prop_assert!(free, "{k} and {l} share stage {}", a.stage);
                }
                if !free {
                    prop_assert!(a.after.contains(&l) || b.after.contains(&k));
                }
            }
        }
    }
}
