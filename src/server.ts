import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  handleCommit,
  handleEdit,
  handleRollback,
  toolDescriptors,
  ToolResult,
} from "./tools.js";
import { ServerState } from "./state.js";

export function createServer(state: ServerState): Server {
  const server = new Server(
    { name: "mcp-edit", version: "0.6.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDescriptors(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = args ?? {};

    let result: ToolResult;
    switch (name) {
      case "edit":
        result = await handleEdit(a, state);
        break;
      case "commit":
        result = await handleCommit(a, state);
        break;
      case "rollback":
        result = await handleRollback(a, state);
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    if (result.ok) {
      return {
        content: [
          { type: "text", text: JSON.stringify(result.data, null, 2) },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.error!.toJSON(), null, 2),
        },
      ],
      isError: true,
    };
  });

  return server;
}