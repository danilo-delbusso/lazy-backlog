import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolCallback = (params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

/**
 * Mock McpServer that captures tool registrations.
 * Call `getTool(name)` to get the registered callback.
 */
export function createMockServer() {
	const tools = new Map<string, ToolCallback>();

	const server = {
		tool: (_name: string, _desc: string, _schema: unknown, callback?: ToolCallback) => {
			// Handle overloaded signatures: (name, desc, schema, callback) or (name, desc, callback)
			if (typeof _schema === "function") {
				tools.set(_name, _schema as unknown as ToolCallback);
			} else if (callback) {
				tools.set(_name, callback);
			}
		},
	} as unknown as McpServer;

	return {
		server,
		getTool: (name: string) => tools.get(name),
		toolNames: () => [...tools.keys()],
	};
}
