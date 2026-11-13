import readline from "node:readline";

const SUPPORTED_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
const FALLBACK_VERSION = "2025-06-18";

function textOf(result, fallback = "") {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n") || fallback;
}

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC).
 * Only the methods this plugin actually needs are implemented.
 */
export function createMcpServer({ name, version, instructions, tools, resources }) {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const replyError = (id, code, message, data) => {
    send({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  };

  function initializeResult(params) {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    return {
      protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : FALLBACK_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      serverInfo: { name, version },
      ...(instructions ? { instructions } : {}),
    };
  }

  function listTools() {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(tool._meta ? { _meta: tool._meta } : {}),
    }));
  }

  async function callTool(params) {
    const toolName = params?.name;
    const tool = toolsByName.get(toolName);
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${toolName}`), { rpcCode: -32602 });
    const args = params?.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) {
      throw Object.assign(new Error("Tool arguments must be an object"), { rpcCode: -32602 });
    }
    try {
      const result = await tool.handler(args);
      if (typeof result === "string") {
        return { content: [{ type: "text", text: result }] };
      }
      return {
        content: Array.isArray(result?.content) ? result.content : [{ type: "text", text: textOf(result) }],
        ...(result?.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        ...(result?.isError ? { isError: true } : {}),
      };
    } catch (error) {
      const code = error?.code ?? "tool_failed";
      const message = error?.message ?? String(error);
      const hint = error?.hint ? `\n${error.hint}` : "";
      return {
        isError: true,
        content: [{ type: "text", text: `[${code}] ${message}${hint}` }],
        structuredContent: {
          error: {
            code,
            message,
            ...(error?.detail === undefined ? {} : { detail: error.detail }),
          },
        },
      };
    }
  }

  async function readResource(params) {
    const uri = params?.uri;
    if (typeof uri !== "string" || !uri.startsWith("ui://")) {
      throw Object.assign(new Error(`Unsupported resource URI: ${uri}`), { rpcCode: -32602 });
    }
    try {
      const contents = await resources.read(uri);
      if (!contents.length) {
        throw Object.assign(new Error(`Resource not found: ${uri}`), { rpcCode: -32002 });
      }
      return { contents };
    } catch (error) {
      if (error?.rpcCode) throw error;
      throw Object.assign(new Error(error?.message ?? `Failed to read ${uri}`), { rpcCode: -32002 });
    }
  }

  async function dispatch(method, params) {
    switch (method) {
      case "initialize":
        return initializeResult(params);
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return undefined;
      case "ping":
        return {};
      case "tools/list":
        return { tools: listTools() };
      case "tools/call":
        return callTool(params);
      case "resources/list":
        return { resources: resources.list() };
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read":
        return readResource(params);
      case "resources/subscribe":
      case "resources/unsubscribe":
        return {};
      case "prompts/list":
        return { prompts: [] };
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
    }
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
    const isNotification = message.id === undefined || message.id === null;
    try {
      const result = await dispatch(message.method, message.params ?? {});
      if (!isNotification) reply(message.id, result ?? {});
    } catch (error) {
      if (isNotification) return;
      replyError(message.id, error?.rpcCode ?? -32603, error?.message ?? "Internal error");
    }
  }

  return {
    start() {
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => {
        handleLine(line).catch((error) => {
          process.stderr.write(`[git-workbench] ${error?.stack ?? error}\n`);
        });
      });
      // Let stdin close the session naturally: pending git commands keep the
      // event loop alive, and their responses must still reach stdout.
      rl.on("close", () => {});
    },
  };
}
