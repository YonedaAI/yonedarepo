# Repository image rerender budget

Real SPA measurements on frontend `38e6f069` / backend `5bb293ee` downloaded the
same two README images on each Overview visit: roughly 250 KB and 188 KB on the
wire. Visible images finished 216–666 ms after core text. Files also made aborted
or repeated image reads when metadata/directory activity rerendered the same
README. This slice targets those rerenders, not cross-navigation downloads.

The rich Markdown reader currently defines its image component inside render.
Each parent render changes that component's identity, unmounting its repository
image, revoking its object URL and starting another authorized blob read.

## Request and lifetime budget

Keep that component stable and supply its resolver through React context. The
same mounted image at the same selected commit and current content/access scope
must make one authorized image request despite unrelated parent rerenders. A
changed source, selected revision or fresh scope must clear its old image and
reauthorize. No new endpoint, provider call, completed-byte cache, shared pending
request, IndexedDB or cross-navigation JavaScript persistence. Unmount still revokes its URL.

Images opt into `revalidate=image` on the existing authorized blob GET. Root's
separate backend switch may return private HTTP revalidation headers only after
fresh authorization/read; old/OFF servers ignore it and retain no-store. This
slice adds no JavaScript HTTP-cache imitation or response reuse.

The fresh scope includes object store, history chain, quarantine epoch, path grant
and viewer identity/access. Incomplete legacy scope metadata gets a fresh key on
each response identity instead of treating absent guards as stable. Apply the
scope to every repository Markdown raster path on Overview, Files and file view.
Files README and its images use the listing's exact commit, preserving edit/blame
branch semantics and version selection. Rendering never substitutes a different
branch head for the selected tree.

## Validation

Reproduce a second blob read after a held directory-activity response rerenders
an already loaded image. Then prove one request while source/scope stays the same.
Fresh quarantine/history/store/viewer/grant changes must remove the old image and
issue a fresh read, including a refused image. Check unknown legacy guards,
selected-commit/ref changes, cancellation and object-URL cleanup. Use real served
React with synthetic API replies and network counts, wide/375px, light/dark,
loading/failure and full images. No live benchmark, inference or writer/load test.
Root owns integration, dev deployment and subsequent real SPA measurements.
