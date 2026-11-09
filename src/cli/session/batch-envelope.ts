import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpxBatchMeta, BatchSplitPart } from "../../acp/batch-meta.js";
import type { PromptInput } from "../../types.js";

export type BatchPromptMember = {
  messageId: string;
  requestId: string;
  prompt: PromptInput;
};

/**
 * The envelope's exact words (UX-SPEC §7, CONTRACTS §2.2). The en dash and em dash are literal.
 * atrium's reader matches `^\[acpx: [^\]\n]*\]\s*$` on block 0 (CONTRACTS §12 A-7).
 */
export function batchEnvelopeText(count: number, split?: BatchSplitPart): string {
  const lead = "delivered together, oldest first — each starts with its own sender header";
  if (!split) {
    return `[acpx: ${count} messages ${lead}]`;
  }
  if (split.from === 1) {
    return `[acpx: ${count} of ${split.total} messages ${lead}; the newer ${split.total - count} follow in the next turn]`;
  }
  const rest = "they continue the previous turn's messages";
  if (split.to === split.total) {
    return `[acpx: the last ${count} of ${split.total} messages ${lead}; ${rest}]`;
  }
  return `[acpx: messages ${split.from}–${split.to} of ${split.total} ${lead}; ${rest}]`;
}

// pi-acp joins text blocks with NO separator (R13 §4.1, `translate/prompt.ts:19`), so the envelope
// and every member's LAST text block end with their own newlines — or two members run together.
const BLOCK_END = "\n\n";

function endWithNewline(blocks: PromptInput): PromptInput {
  let last = -1;
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      last = index;
    }
  });
  if (last < 0) {
    return blocks;
  }
  const block = blocks[last] as Extract<ContentBlock, { type: "text" }>;
  if (block.text.endsWith("\n")) {
    return blocks;
  }
  const copy = [...blocks];
  copy[last] = { ...block, text: `${block.text}${BLOCK_END}` };
  return copy;
}

/**
 * The prompt and `_meta` of a batch turn: envelope (block 0), then each member's blocks in order.
 * `undefined` for a batch of ONE that is not a split part — that turn is byte-identical to today's
 * single prompt (no envelope, no `_meta`), which is a committed golden-file guarantee.
 */
export function buildBatchPrompt(
  members: readonly BatchPromptMember[],
  split?: BatchSplitPart,
): { prompt: PromptInput; meta: AcpxBatchMeta } | undefined {
  if (members.length === 0 || (members.length === 1 && !split)) {
    return undefined;
  }
  const prompt: PromptInput = [
    { type: "text", text: `${batchEnvelopeText(members.length, split)}${BLOCK_END}` },
  ];
  const layout: AcpxBatchMeta["members"] = [];
  for (const member of members) {
    const blocks = endWithNewline(member.prompt);
    layout.push({
      messageId: member.messageId,
      requestId: member.requestId,
      first: prompt.length,
      count: blocks.length,
    });
    prompt.push(...blocks);
  }
  return {
    prompt,
    meta: {
      v: 1,
      envelope: { first: 0, count: 1 },
      members: layout,
      ...(split ? { split } : {}),
    },
  };
}
