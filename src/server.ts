import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  handleCommitFile,
  handleEditFile,
  handleListTransactions,
  handleReadFile,
  handleRollbackFile,
  handleSearchFile,
  toolDescriptors,
  ToolResult,
} from "./tools.js";
import { ServerState } from "./state.js";

export function createServer(state: ServerState): Server {
  const server = new Server(
    { name: "mcp-edit", version: "0.4.0" },
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
      case "read_file":
        result = await handleReadFile(a, state);
        break;
      case "search_file":
        result = await handleSearchFile(a, state);
        break;
      case "edit_file":
        result = await handleEditFile(a, state);
        break;
      case "commit_file":
        result = await handleCommitFile(a, state);
        break;
      case "rollback_file":
        result = await handleRollbackFile(a, state);
        break;
      case "list_transactions":
        result = await handleListTransactions(a, state);
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