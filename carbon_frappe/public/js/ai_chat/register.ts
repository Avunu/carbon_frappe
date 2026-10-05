// Registers every <cds-aichat-*> element the chat uses, for its side effect.
//
// prompt-line is imported piece by piece, never through `prompt-line/index.js`:
// the barrel statically re-exports the mention and autocomplete extensions, which
// pulls tiptap and prosemirror (+113 KB gzip) into the first load. The textarea
// surface needs none of it, and `rich` is never set, so the runtime stays a lazy chunk.
import "@carbon/ai-chat-components/es/components/chat-shell/index.js";
import "@carbon/ai-chat-components/es/components/prompt-line/src/prompt-line-shell.js";
import "@carbon/ai-chat-components/es/components/prompt-line/src/prompt-line.js";
import "@carbon/ai-chat-components/es/components/prompt-line/src/send-control.js";
import "@carbon/ai-chat-components/es/components/prompt-line/src/stop-streaming-button.js";
import "@carbon/ai-chat-components/es/components/markdown/index.js";
import "@carbon/ai-chat-components/es/components/chain-of-thought/index.js";
import "@carbon/ai-chat-components/es/components/feedback/index.js";
import "@carbon/ai-chat-components/es/components/processing/index.js";
import "@carbon/ai-chat-components/es/components/code-snippet/index.js";
import "@carbon/ai-chat-components/es/components/chat-button/index.js";
import "@carbon/ai-chat-components/es/components/chat-history/index.js";
// The attachment chips and the composer's error line. file-uploads pulls Carbon's file-uploader and nine
// document glyphs (about 17.6 KB gzip); error-message is small and shares the icon button the toolbar loads.
import "@carbon/ai-chat-components/es/components/file-uploads/index.js";
import "@carbon/ai-chat-components/es/components/prompt-line/src/error-message.js";
