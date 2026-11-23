import { existsSync, writeFileSync } from "node:fs";
import { acp, action, defineFlow } from "acpx/flows";

// A-60 rows 60.2-60.4, 60.12 (brick f67e0ff1): the c917d9c9 probe's flow. n1 runs an ordinary turn
// (creating the flow's session), n2 parks until the test writes `go-n3`, n3 runs a second turn on the
// SAME session — by then a queue owner of a second actor may be mid-turn on it.
const DIR = process.env.A60_DIR ?? "";

async function waitForFile(name: string): Promise<void> {
  const target = `${DIR}/${name}`;
  const started = Date.now();
  while (!existsSync(target)) {
    if (Date.now() - started > 600_000) {
      throw new Error(`timeout waiting for ${name}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export default defineFlow({
  name: "a60-f4",
  startAt: "n1",
  nodes: {
    n1: acp({
      session: { handle: "main" },
      prompt: () => "echo N1-FLOW-TURN",
      parse: (text) => ({ t: text }),
    }),
    n2: action({
      run: async () => {
        writeFileSync(`${DIR}/at-n2`, new Date().toISOString());
        await waitForFile("go-n3");
        return { ok: true };
      },
    }),
    n3: acp({
      session: { handle: "main" },
      prompt: () => "echo N3-FLOW-TURN",
      parse: (text) => ({ t: text }),
    }),
  },
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
  ],
});
