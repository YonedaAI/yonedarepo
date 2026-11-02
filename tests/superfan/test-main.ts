// The test Worker: Superfan's entrypoint, plus the dead-man's Durable Object class. They are two
// Workers in production; here one workerd runs both.
export { DeadmanState } from '../../cloudflare/superfan/deadman';
export { default, SuperfanLedger } from '../../cloudflare/superfan/index';
