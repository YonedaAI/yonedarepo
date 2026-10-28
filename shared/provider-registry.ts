// The provider registry lives in yoneda-core (`provider_registry.json`) as the single
// source of truth; this module only re-exports it for the TypeScript side.
import providerRegistry from '../backend/crates/yoneda-core/src/provider_registry.json';

export { providerRegistry };
