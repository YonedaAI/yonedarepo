use super::{EvaluationSource, SOURCE_FILE_MAX, SourceChange, SourceNode, failure};
use yoneda_agents_core::Result;
pub(super) fn apply(
    cow: &EvaluationSource,
    _id: &str,
    change: &SourceChange,
) -> Result<Option<SourceNode>> {
    let mut state = cow
        .state
        .lock()
        .map_err(|_| failure("SOURCE_LOCK", "Evaluation lock failed"))?;
    let current = match cow.stat_locked(&state, change.path()) {
        Ok(node) => Some(node),
        Err(error) if error.code == "SOURCE_NOT_FOUND" => None,
        Err(error) => return Err(error),
    };
    let expected = match change {
        SourceChange::Create { .. } => None,
        SourceChange::Write { expected, .. }
        | SourceChange::Truncate { expected, .. }
        | SourceChange::Mode { expected, .. }
        | SourceChange::Delete { expected, .. }
        | SourceChange::Rename { expected, .. } => Some(*expected),
    };
    if current.as_ref().map(|node| node.version) != expected {
        return Err(failure("FILE_VERSION_CONFLICT", "Evaluation file changed"));
    }
    if current.as_ref().is_some_and(SourceNode::directory) {
        return Err(failure(
            "SOURCE_UNSUPPORTED",
            "Evaluation directory mutation unsupported",
        ));
    }
    let next = state
        .version
        .max(current.as_ref().map_or(0, |node| node.version))
        .checked_add(1)
        .ok_or_else(|| failure("SOURCE_LIMIT", "Evaluation version overflow"))?;
    let mode = current.as_ref().map_or(0o100644, |node| node.mode);
    let node = match change {
        SourceChange::Create { mode, .. } => {
            state.version = next;
            cow.save(&mut state, change.path(), *mode, &[])?
        }
        SourceChange::Delete { .. } => {
            state.version = next;
            state.entries.insert(change.path().into(), None);
            return Ok(None);
        }
        SourceChange::Write { offset, bytes, .. } => {
            let node =
                current.ok_or_else(|| failure("SOURCE_NOT_FOUND", "Missing evaluation file"))?;
            let length = node.size.max(
                offset
                    .checked_add(bytes.len() as u64)
                    .ok_or_else(|| failure("SOURCE_LIMIT", "Evaluation size overflow"))?,
            );
            if length > SOURCE_FILE_MAX {
                return Err(failure("SOURCE_LIMIT", "Evaluation write exceeds limit"));
            }
            let mut content = cow.bytes_locked(&state, &node, node.size)?;
            content.resize(length as usize, 0);
            content[*offset as usize..*offset as usize + bytes.len()].copy_from_slice(bytes);
            state.version = next;
            cow.save(&mut state, change.path(), mode, &content)?
        }
        SourceChange::Truncate { size, .. } => {
            let node =
                current.ok_or_else(|| failure("SOURCE_NOT_FOUND", "Missing evaluation file"))?;
            if *size > SOURCE_FILE_MAX {
                return Err(failure("SOURCE_LIMIT", "Evaluation size exceeds limit"));
            }
            let mut content = cow.bytes_locked(&state, &node, node.size.min(*size))?;
            content.resize(*size as usize, 0);
            state.version = next;
            cow.save(&mut state, change.path(), mode, &content)?
        }
        SourceChange::Mode { mode, .. } => {
            let node =
                current.ok_or_else(|| failure("SOURCE_NOT_FOUND", "Missing evaluation file"))?;
            state.version = next;
            cow.metadata(&mut state, &node, change.path(), *mode)?
        }
        SourceChange::Rename {
            target,
            target_expected,
            ..
        } => {
            let target_node = match cow.stat_locked(&state, target) {
                Ok(node) => Some(node),
                Err(error) if error.code == "SOURCE_NOT_FOUND" => None,
                Err(error) => return Err(error),
            };
            if target_node.as_ref().map(|node| node.version) != *target_expected
                || target_node.as_ref().is_some_and(SourceNode::directory)
            {
                return Err(failure(
                    "FILE_VERSION_CONFLICT",
                    "Evaluation destination changed",
                ));
            }
            let node =
                current.ok_or_else(|| failure("SOURCE_NOT_FOUND", "Missing evaluation file"))?;
            state.version = next;
            let target = cow.metadata(&mut state, &node, target, mode)?;
            state.entries.insert(change.path().into(), None);
            target
        }
    };
    Ok(Some(node))
}
