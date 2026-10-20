// Capability brokers a harness container may reach; every other host is blocked.
import type { OutboundHandler } from '@cloudflare/containers';
import { brokerHandler } from './broker';
import { ExecutionContainer } from './container';
import { dependencyHandler, registries } from './dependencies';
import { modelHandler } from './models';
import { sourceBroker } from './source-broker';

ExecutionContainer.outboundByHost = {
  ...Object.fromEntries(registries.map((host) => [host, dependencyHandler as OutboundHandler])),
  'yoneda.internal': brokerHandler as OutboundHandler,
  'source.yoneda.internal': sourceBroker as OutboundHandler,
  'codex.yoneda.internal': modelHandler('codex') as OutboundHandler,
  'gemini.yoneda.internal': modelHandler('gemini') as OutboundHandler,
  'claude.yoneda.internal': modelHandler('claude') as OutboundHandler,
};

export { ExecutionContainer };
