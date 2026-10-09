import type { OutboundHandler } from '@cloudflare/containers';
import { brokerHandler } from './broker';
import { ExecutionContainer } from './container';
import { dependencyHandler, registries } from './dependencies';
import { gitHandler } from './git';
import { modelHandler } from './models';

export { ContainerProxy } from '@cloudflare/containers';
export {
  LiveRoom,
  RepositoryAuthority,
  WorkspaceAuthority,
} from '../../backend/crates/yoneda-worker/build/worker/shim.mjs';
export { YonedaEntrypoint as default } from './entrypoint';
export { ExecutionContainer };

ExecutionContainer.outboundByHost = {
  ...Object.fromEntries(registries.map((host) => [host, dependencyHandler as OutboundHandler])),
  'yoneda.internal': brokerHandler as OutboundHandler,
  'codex.yoneda.internal': modelHandler('codex') as OutboundHandler,
  'gemini.yoneda.internal': modelHandler('gemini') as OutboundHandler,
  'claude.yoneda.internal': modelHandler('claude') as OutboundHandler,
  'git.yoneda.internal': gitHandler as OutboundHandler,
};
