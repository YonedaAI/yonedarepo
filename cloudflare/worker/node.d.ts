// The one Node API the Worker uses (nodejs_compat); @types/node would pull in all of Node.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
