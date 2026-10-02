// Launcher: the DIRECTORY name carries the adapter token acpx classifies on
// (src/acp/adapter-token.ts:46). The token is passed explicitly rather than derived
// from import.meta.url, because Node resolves a symlinked module to its realpath and
// would hand back the shared implementation path instead of this directory.
import { runProxy } from "../../proxy-impl.mjs";

runProxy("claude-agent-acp");
