/**
 * Compatibility fetch for OpenAI-compatible Responses gateways.
 *
 * The AI SDK may include `item_reference` entries when continuing a tool
 * conversation. A number of compatible gateways do not implement that input
 * item yet; function calls and outputs remain self-contained, so dropping only
 * those references keeps the request usable without changing the protocol.
 */
export const responsesCompatibleFetch: typeof globalThis.fetch = async (input, init) => {
  if (typeof init?.body !== "string") return globalThis.fetch(input, init);
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (!Array.isArray(body.input)) return globalThis.fetch(input, init);
    const inputItems = body.input.filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && (item as Record<string, unknown>).type !== "item_reference",
    );
    return globalThis.fetch(input, {
      ...init,
      body: JSON.stringify({ ...body, input: inputItems }),
    });
  } catch {
    return globalThis.fetch(input, init);
  }
};
