//! The Wasm stack a call from JavaScript starts with. wasm32's stack (1 MiB, below the
//! data) grows down to address 0, and an export called from the top starts a few KiB into
//! it. A request terminated mid-Wasm (the isolate's CPU or memory limit) unwinds no Rust
//! frame and runs no JavaScript, so `__stack_pointer` stays where the cut-off call left
//! it: the isolate keeps serving with less stack, and a later ordinary call overflows it
//! (`memory access out of bounds`). Dev, 2026-10-29: an Overview failed so six seconds
//! after two queue jobs in the same Worker were killed for exceeding memory.

/// Where the stack starts (rustc's default stack size for wasm32, laid out first).
const STACK_TOP: usize = 1024 * 1024;
/// Stack a call from the top may find used before the instance counts as cut short.
const HEADROOM_LOST: usize = 64 * 1024;

/// The bytes an earlier call left on the stack when that is past HEADROOM_LOST, given the
/// stack left below this call (`yoneda_platform::stack_left`).
fn leaked(left: usize) -> Option<usize> {
    let lost = STACK_TOP.saturating_sub(left);
    (lost > HEADROOM_LOST).then_some(lost)
}

/// `Err(WASM_RESET)` when this instance's stack was cut short: a fresh instance is then
/// scheduled for the next call (the adapter settles it and calls again).
pub(crate) fn check() -> yoneda_core::Result<()> {
    let Some(lost) = yoneda_platform::stack_left().and_then(leaked) else {
        return Ok(());
    };
    worker::wasm_bindgen::handler::schedule_reinit();
    Err(yoneda_core::Error::new(
        "WASM_RESET",
        format!(
            "This isolate's Wasm stack had lost {lost} bytes to a call cut off midway; the instance is reset"
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_stack_cut_short_resets() {
        // What a call from the top finds (local workerd): about 3 KiB in.
        assert_eq!(leaked(1_047_643), None);
        assert_eq!(leaked(STACK_TOP - HEADROOM_LOST), None);
        assert_eq!(leaked(512 * 1024), Some(512 * 1024));
        assert_eq!(leaked(0), Some(STACK_TOP));
    }
}
