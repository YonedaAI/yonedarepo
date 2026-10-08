import type { OutboundHandler } from '@cloudflare/containers';
import { brokerHandler } from './broker';
import { ExecutionContainer } from './container';
import { gitHandler } from './git';
import { modelHandler } from './models';

export { ContainerProxy } from '@cloudflare/containers';
export { LiveRoom, RepositoryAuthority } from '../crates/yoneda-worker/build/worker/shim.mjs';
export { YonedaEntrypoint as default } from './entrypoint';
export { ExecutionContainer };

ExecutionContainer.outboundByHost = {
  'yoneda.internal': brokerHandler as OutboundHandler,
  'codex.yoneda.internal': modelHandler('codex') as OutboundHandler,
  'claude.yoneda.internal': modelHandler('claude') as OutboundHandler,
  'git.yoneda.internal': gitHandler as OutboundHandler,
};
