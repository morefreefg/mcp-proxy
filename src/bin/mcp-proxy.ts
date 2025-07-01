#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { EventSource } from "eventsource";
import { setTimeout } from "node:timers";
import util from "node:util";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { InMemoryEventStore } from "../InMemoryEventStore.js";
import { proxyServer } from "../proxyServer.js";
import { startHTTPServer } from "../startHTTPServer.js";
import { StdioClientTransport } from "../StdioClientTransport.js";

util.inspect.defaultOptions.depth = 8;

if (!("EventSource" in global)) {
  // @ts-expect-error - figure out how to use --experimental-eventsource with vitest
  global.EventSource = EventSource;
}

const argv = await yargs(hideBin(process.argv))
  .scriptName("mcp-proxy")
  .command("$0 [command] [args...]", "Run MCP proxy with optional command")
  .positional("command", {
    describe: "The command to run (optional for dynamic proxy mode)",
    type: "string",
  })
  .positional("args", {
    array: true,
    describe: "The arguments to pass to the command",
    type: "string",
  })
  .env("MCP_PROXY")
  .options({
    debug: {
      default: false,
      describe: "Enable debug logging",
      type: "boolean",
    },
    endpoint: {
      describe: "The endpoint to listen on",
      type: "string",
    },
    port: {
      default: 8080,
      describe: "The port to listen on",
      type: "number",
    },
    server: {
      choices: ["sse", "stream"],
      describe: "The server type to use (sse or stream). By default, both are enabled",
      type: "string",
    },
    shell: {
      default: false,
      describe: "Spawn the server via the user's shell",
      type: "boolean",
    },
    sseEndpoint: {
      default: "/sse",
      describe: "The SSE endpoint to listen on",
      type: "string",
    },
    streamEndpoint: {
      default: "/mcp",
      describe: "The stream endpoint to listen on",
      type: "string",
    },
    enableProxy: {
      default: true,
      describe: "Enable HTTP proxy functionality",
      type: "boolean",
    },
    dynamicProxy: {
      default: false,
      describe: "Enable dynamic MCP proxy mode (no fixed backend server)",
      type: "boolean",
    },
  })
  .help()
  .parseAsync();

const connect = async (client: Client) => {
  // 添加类型检查 - 只有在非动态代理模式下才需要command
  if (!argv.dynamicProxy && !argv.command) {
    throw new Error("Command is required when not using dynamic proxy mode");
  }
  
  // 如果是动态代理模式，不需要连接到固定服务器
  if (argv.dynamicProxy) {
    return;
  }
  
  const transport = new StdioClientTransport({
    args: argv.args,
    command: argv.command!, // 使用非空断言，因为我们已经检查过了
    env: process.env as Record<string, string>,
    onEvent: (event) => {
      if (argv.debug) {
        console.debug("transport event", event);
      }
    },
    shell: argv.shell as boolean,
    stderr: "pipe",
  });

  await client.connect(transport);
};

const proxy = async () => {
  let client: Client | null = null;
  let serverVersion: { name: string; version: string } | null = null;
  let serverCapabilities: { capabilities: Record<string, unknown> } | null = null;

  // 只有在非动态代理模式下才创建固定的client连接
  if (!argv.dynamicProxy) {
    client = new Client(
      {
        name: "mcp-proxy",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    await connect(client);

    serverVersion = client.getServerVersion() as {
      name: string;
      version: string;
    };

    serverCapabilities = client.getServerCapabilities() as {
      capabilities: Record<string, unknown>;
    };
  }

  console.info("starting server on port %d", argv.port);

  const createServer = async () => {
    if (!argv.dynamicProxy && client && serverVersion && serverCapabilities) {
      // 固定代理模式
      const server = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      proxyServer({ client, server, serverCapabilities });

      return server;
    } else {
      // 动态代理模式 - 返回一个简单的服务器实例
      return new Server(
        { name: "mcp-proxy", version: "1.0.0" },
        { capabilities: {} }
      );
    }
  };

  await startHTTPServer({
    createServer,
    eventStore: new InMemoryEventStore(),
    port: argv.port,
    sseEndpoint: argv.server && argv.server !== "sse" ? null : (argv.sseEndpoint ?? argv.endpoint),
    streamEndpoint: argv.server && argv.server !== "stream" ? null : (argv.streamEndpoint ?? argv.endpoint),
    enableProxy: argv.enableProxy, // 新增参数
  });
};

const main = async () => {
  process.on("SIGINT", () => {
    console.info("SIGINT received, shutting down");

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });

  try {
    await proxy();
  } catch (error) {
    console.error("could not start the proxy", error);

    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
};

await main();
