//! Strongly connected components (Tarjan), iterative so deep reference chains cannot
//! overflow the stack.

/// Components of the graph `edges[v] = successors of v`, each sorted, emitted in reverse
/// topological order of the condensation (a component comes before any that reach it).
/// Successors outside `0..edges.len()` are ignored.
pub fn tarjan(edges: &[Vec<usize>]) -> Vec<Vec<usize>> {
    const UNSEEN: usize = usize::MAX;
    let n = edges.len();
    let mut index = vec![UNSEEN; n];
    let mut low = vec![0; n];
    let mut on_stack = vec![false; n];
    let mut stack = Vec::new();
    let mut components = Vec::new();
    let mut next = 0;
    // Each frame is (vertex, position of the next successor to visit).
    let mut frames: Vec<(usize, usize)> = Vec::new();
    for root in 0..n {
        if index[root] != UNSEEN {
            continue;
        }
        frames.push((root, 0));
        index[root] = next;
        low[root] = next;
        next += 1;
        stack.push(root);
        on_stack[root] = true;
        while let Some(frame) = frames.last_mut() {
            let (v, position) = *frame;
            if let Some(&w) = edges[v].get(position) {
                frame.1 += 1;
                if w >= n {
                    continue;
                }
                if index[w] == UNSEEN {
                    index[w] = next;
                    low[w] = next;
                    next += 1;
                    stack.push(w);
                    on_stack[w] = true;
                    frames.push((w, 0));
                } else if on_stack[w] {
                    low[v] = low[v].min(index[w]);
                }
                continue;
            }
            frames.pop();
            if let Some(&(parent, _)) = frames.last() {
                low[parent] = low[parent].min(low[v]);
            }
            if low[v] == index[v] {
                let mut component = Vec::new();
                while let Some(w) = stack.pop() {
                    on_stack[w] = false;
                    component.push(w);
                    if w == v {
                        break;
                    }
                }
                component.sort_unstable();
                components.push(component);
            }
        }
    }
    components
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn reach(edges: &[Vec<usize>]) -> Vec<Vec<bool>> {
        let n = edges.len();
        let mut r = vec![vec![false; n]; n];
        for (v, row) in r.iter_mut().enumerate() {
            row[v] = true;
            let mut todo = vec![v];
            while let Some(u) = todo.pop() {
                for &w in &edges[u] {
                    if !row[w] {
                        row[w] = true;
                        todo.push(w);
                    }
                }
            }
        }
        r
    }

    #[test]
    fn finds_cycles_and_singletons() {
        let edges = vec![vec![1], vec![2], vec![0, 3], vec![], vec![4]];
        let mut found = tarjan(&edges);
        found.sort();
        assert_eq!(found, vec![vec![0, 1, 2], vec![3], vec![4]]);
    }

    #[test]
    fn a_long_chain_does_not_recurse() {
        let n = 200_000;
        let edges: Vec<Vec<usize>> = (0..n).map(|v| vec![(v + 1) % n]).collect();
        assert_eq!(tarjan(&edges).len(), 1);
    }

    proptest! {
        #[test]
        fn matches_mutual_reachability(
            n in 1usize..24,
            pairs in proptest::collection::vec((0usize..24, 0usize..24), 0..80),
        ) {
            let mut edges = vec![Vec::new(); n];
            for (a, b) in pairs {
                if a < n && b < n {
                    edges[a].push(b);
                }
            }
            let r = reach(&edges);
            let components = tarjan(&edges);
            let mut component_of = vec![usize::MAX; n];
            for (i, c) in components.iter().enumerate() {
                for &v in c {
                    prop_assert_eq!(component_of[v], usize::MAX, "vertex in two components");
                    component_of[v] = i;
                }
            }
            for a in 0..n {
                for b in 0..n {
                    prop_assert_eq!(component_of[a] == component_of[b], r[a][b] && r[b][a]);
                }
            }
            // Reverse topological: an edge never points to a later component.
            for (a, successors) in edges.iter().enumerate() {
                for &b in successors {
                    prop_assert!(component_of[b] <= component_of[a]);
                }
            }
        }
    }
}
