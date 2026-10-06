/**
 * M1a — does acpx's OWN prompt-content gate reject an appended TEXT block?
 *
 * The gate is `getUnsupportedPromptContentMessage(prompt, agentCapabilities)`
 * (src/prompt-content.ts:230), called from `AcpClient.normalizePromptForAgent`
 * (src/acp/client.ts:2405) before every `session/prompt`. Its ONLY harness-specific
 * input is the adapter's advertised `agentCapabilities`, so enumerating that input
 * space settles the question for every harness at once.
 *
 * CONTROL: the same instrument must REJECT an appended `image` block whenever the
 * adapter has not advertised `promptCapabilities.image` — otherwise a clean sheet of
 * "accepted" proves only that the probe is blind.
 *
 * Run: node probe/perturn/m1a-prompt-gate.mjs   (after `pnpm run build:test`)
 */
import { getUnsupportedPromptContentMessage } from "../../dist-test/src/prompt-content.js";

const CAP_CASES = [
  ["agentCapabilities: undefined", undefined],
  ["{} (no promptCapabilities)", {}],
  ["promptCapabilities: {}", { promptCapabilities: {} }],
  [
    "all prompt caps FALSE",
    { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
  ],
  [
    "all prompt caps TRUE",
    { promptCapabilities: { image: true, audio: true, embeddedContext: true } },
  ],
];

const userText = { type: "text", text: "the user's real prompt" };
const injectedText = { type: "text", text: "⟦PER-TURN⟧ nonce=ABC123" };
const injectedImage = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
const injectedAudio = { type: "audio", mimeType: "audio/wav", data: "UklGRg==" };
const injectedResource = {
  type: "resource",
  resource: { uri: "file:///x", mimeType: "text/plain", text: "x" },
};

const PROMPT_CASES = [
  ["SUBJECT  text appended after user block", [userText, injectedText]],
  ["SUBJECT  text prepended before user block", [injectedText, userText]],
  ["SUBJECT  two text blocks appended", [userText, injectedText, injectedText]],
  ["CONTROL  image appended", [userText, injectedImage]],
  ["CONTROL  audio appended", [userText, injectedAudio]],
  ["CONTROL  resource appended", [userText, injectedResource]],
];

let subjectAccepted = 0;
let subjectRejected = 0;
let controlRejected = 0;
let controlAccepted = 0;

for (const [promptLabel, prompt] of PROMPT_CASES) {
  for (const [capLabel, caps] of CAP_CASES) {
    const message = getUnsupportedPromptContentMessage(prompt, caps);
    const verdict = message === undefined ? "ACCEPTED" : "REJECTED";
    if (promptLabel.startsWith("SUBJECT")) {
      message === undefined ? subjectAccepted++ : subjectRejected++;
    } else {
      message === undefined ? controlAccepted++ : controlRejected++;
    }
    console.log(
      `${promptLabel.padEnd(42)} | ${capLabel.padEnd(30)} | ${verdict}${message ? `  -> ${message}` : ""}`,
    );
  }
}

console.log("");
console.log(`SUBJECT (text blocks):  accepted=${subjectAccepted}  rejected=${subjectRejected}`);
console.log(`CONTROL (non-text):     accepted=${controlAccepted}  rejected=${controlRejected}`);
console.log(
  controlRejected > 0
    ? "CONTROL BIT: the instrument does reject content it should reject."
    : "CONTROL FAILED: instrument never rejects anything — result is worthless.",
);
