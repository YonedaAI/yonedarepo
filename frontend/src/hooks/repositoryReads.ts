/** Cancels obsolete GETs only. Mutations have their own acknowledgment/reconciliation protocol. */
export class RepositoryReads {
  private controllers = new Set<AbortController>();
  begin() {
    const controller = new AbortController();
    this.controllers.add(controller);
    return controller;
  }
  end(controller: AbortController) {
    this.controllers.delete(controller);
  }
  cancel() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
