// Compatibility surface: callers can keep importing the historical symbols
// while the canonical definitions live in model-catalog.ts.
export {
  KNOWN_MODELS_BY_PROVIDER,
  KNOWN_PROVIDERS,
  isKnownModel,
  isKnownProvider,
  type KnownProvider,
} from './model-catalog.js';
