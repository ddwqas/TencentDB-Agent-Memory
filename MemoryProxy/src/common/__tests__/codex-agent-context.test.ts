import { describe, expect, it } from "vitest";

import { injectCodexAgentContext } from "../../codexHandler.js";

describe("injectCodexAgentContext", () => {
  it("appends Agent context to existing instructions", () => {
    const body = { instructions: "base instructions", input: [] };

    expect(injectCodexAgentContext(body, "<session_context>Agent</session_context>"))
      .toEqual({
        instructions: "base instructions\n\n<session_context>Agent</session_context>",
        input: [],
      });
    expect(body.instructions).toBe("base instructions");
  });

  it("creates instructions when the request has none", () => {
    expect(injectCodexAgentContext(
      { input: [] },
      "<session_context>Agent</session_context>",
    )).toEqual({
      instructions: "<session_context>Agent</session_context>",
      input: [],
    });
  });
});
