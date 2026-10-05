// A module with no exports, standing in for two @carbon/ai-chat-components
// entry points whose published declarations do not typecheck (see the `paths`
// entries in tsconfig.base.json). The runtime import is untouched: esbuild builds
// the chat bundle without a tsconfig, so it resolves the real modules.
export type EmptyModule = Record<never, never>;
