import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Config } from "./config.js";
import {
  handleReadFile,
  handleSearchFile,
  toolDescriptors,
  ToolResult,
} from "./tools.js";

export function createServer(config: Config): Server {
  const server = new Server(
    { name: "mcp-edit", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDescriptors(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    let result: ToolResult;
    switch (name) {
      case "read_file":
        result = await handleReadFile(args ?? {}, config);
        break;
      case "search_file":
        result = await handleSearchFile(args ?? {}, config);
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