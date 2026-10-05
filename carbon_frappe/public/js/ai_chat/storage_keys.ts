// localStorage keys that both the always-loaded shell code (anatomy/shell/assistant.ts) and the
// lazily loaded chat read or write. A leaf module on purpose: the shell can import it without
// pulling any chat code into carbon_anatomy.bundle, and the chat does not depend on the shell.

/** The Flow Session name the chat resumes; "" means "start a new chat". Written by the controller. */
export const SESSION_KEY = "cf-ai-session";

/** Optional Flow Agent name for new sessions. Read by the controller; unset means flow's default. */
export const AGENT_KEY = "cf-ai-agent";
