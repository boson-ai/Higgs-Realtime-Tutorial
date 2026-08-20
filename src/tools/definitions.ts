// The tool definitions sent in session.update.
//
// The shape is the same JSON Schema you would use anywhere else:
//
//   { type: "function", name, description, parameters }
//
// There is no "executor" field and nothing to register a callback with. The
// server tells you a tool was called; running it is entirely your business.
// That is the whole of "client-side tool execution" — the client is where the
// code is because the client is where you put it.

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "web_search",
    description:
      "Search the web. Call this whenever the user asks about anything current " +
      "or local — news, weather, sport results, opening hours — or anything you " +
      "are not sure of, rather than guessing. Say a short acknowledgement before " +
      "calling it, since it may take a moment.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What the user is looking for, in their own words — e.g. 'ferry " +
            "schedule', 'weekend weather'. Pass what they actually said.",
        },
        topic: {
          type: "string",
          // An enum is worth more here than in a typed UI. Speech recognition
          // mangles vocabulary, and a closed list pulls the model back onto a
          // valid value instead of inventing one.
          enum: ["news", "weather", "sports", "science", "travel"],
          description: "Optional topic filter.",
        },
      },
      required: ["query"],
    },
  },
] as const;
