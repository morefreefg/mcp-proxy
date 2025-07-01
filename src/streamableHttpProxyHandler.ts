import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "node:crypto";
import { URL } from "url";

import { InMemoryEventStore } from "./InMemoryEventStore.js";
import { proxyServer } from "./proxyServer.js";

/** 活跃的代理连接：Map<sessionId, Connection> */
const activeProxyConnections: Record<
  string,
  {
    client: Client;
    clientTransport: StreamableHTTPClientTransport;
    server: Server;
    serverTransport: StreamableHTTPServerTransport;
  }
> = {};

/** 读取并解析 HTTP Body（可能为空） */
const getBody = (request: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    const chunks: Buffer[] = [];
    request
      .on("data", (c: Buffer) => chunks.push(c))
      .on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        if (!raw.trim()) return resolve(null);
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          console.error("[streamable-proxy] body parse error:", err);
          resolve(null);
        }
      });
  });

/** 核心处理函数 */
export const handleStreamableHttpProxy = async (
  req: IncomingMessage,
  res: ServerResponse,
  targetUrl: string
): Promise<boolean> => {
  try {
    const target = new URL(targetUrl);

    /* ---------- CORS ---------- */
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS, PATCH"
      );
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Expose-Headers", "*");
    }

    const sessionIdHeader = Array.isArray(req.headers["mcp-session-id"])
      ? req.headers["mcp-session-id"][0]
      : req.headers["mcp-session-id"];

    const body = await getBody(req);

    /* ---------- 调试日志 ---------- */
    console.log(
      `[DEBUG] ${req.method} ${req.url}  session=${sessionIdHeader}  initialize=${isInitializeRequest(
        body
      )}`
    );

    /* ========== 1. 处理 initialize ========= */
    if (isInitializeRequest(body)) {
      const initParams = (body as any).params ?? {};
      let newSessionId = sessionIdHeader ?? randomUUID();

      /* 检查是否已存在连接，避免重复初始化 */
      if (activeProxyConnections[newSessionId]) {
        console.log(`[streamable-proxy] Session ${newSessionId} already exists, reusing connection`);
        await activeProxyConnections[newSessionId].serverTransport.handleRequest(req, res, body);
        return true;
      }

      /* 检查是否有全局连接可以复用（针对单例服务器） */
      const globalSessionId = "global-mcp-session";
      if (activeProxyConnections[globalSessionId]) {
        console.log(`[streamable-proxy] Using existing global connection for new session ${newSessionId}`);
        /* 为新session创建一个指向全局连接的引用 */
        activeProxyConnections[newSessionId] = activeProxyConnections[globalSessionId];
        await activeProxyConnections[newSessionId].serverTransport.handleRequest(req, res, body);
        return true;
      }

      /* 先连上游 Server，转发 initialize 拿能力 */
      const clientTransport = new StreamableHTTPClientTransport(target);
      const client = new Client(
        {
          name: "mcp-proxy-client",
          version: "1.0.0"
        },
        {
          capabilities: {}
        }
      );
      await client.connect(clientTransport);
      
      let serverCapabilities: any = {};
      let isGlobalConnection = false;
      
      try {
        const response = await client.request(
          {
            method: "initialize",
            params: initParams
          },
          InitializeResultSchema
        );
        serverCapabilities = response.capabilities;
      } catch (error: any) {
        /* 如果服务器已经初始化，说明这是一个单例服务器，创建全局连接 */
        if (error.message && error.message.includes("Server already initialized")) {
          console.log(`[streamable-proxy] Target server already initialized, creating global connection`);
          
          /* 使用默认能力，这个连接将作为全局连接 */
          serverCapabilities = {
            tools: {},
            resources: {},
            prompts: {},
            logging: {}
          };
          
          isGlobalConnection = true;
          newSessionId = globalSessionId;
        } else {
          throw error;
        }
      }

      /* 用真实 capabilities 启本地 Server */
      const server = new Server(
        { name: "mcp-proxy-server", version: "1.0.0" },
        { capabilities: serverCapabilities }
      );

      /* 搭桥：把所有请求在 server ↔ client 间转发 */
      await proxyServer({ server, client, serverCapabilities });

      /* IDE ↔ proxy 的 serverTransport */
      const serverTransport = new StreamableHTTPServerTransport({
        eventStore: new InMemoryEventStore(),
        sessionIdGenerator: () => newSessionId,
      });

      /* 保存连接，以便后续复用 */
      const connection = {
        client,
        clientTransport,
        server,
        serverTransport,
      };
      
      activeProxyConnections[newSessionId] = connection;
      
      /* 如果这是全局连接，也为原始session ID创建引用（如果不同的话） */
      if (isGlobalConnection && sessionIdHeader && sessionIdHeader !== globalSessionId) {
        activeProxyConnections[sessionIdHeader] = connection;
      }

      /* 让 serverTransport 处理这次 initialize 请求 */
      await serverTransport.handleRequest(req, res, body);

      console.log(
        `[streamable-proxy] Session ${newSessionId} initialized${isGlobalConnection ? ' (global)' : ''}, capabilities keys: ${Object.keys(
          serverCapabilities || {}
        ).join(",")}`
      );
      return true;
    }

    /* ========== 2. 后续请求 ========= */
    const connection = sessionIdHeader
      ? activeProxyConnections[sessionIdHeader]
      : undefined;

    if (!connection) {
      /* session 不存在 —— 返回 JSON-RPC 错误 */
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: -32000, message: "Session not found" },
          id: null,
          jsonrpc: "2.0",
        })
      );
      return true;
    }

    /* 交给已保存的 serverTransport 继续处理 */
    await connection.serverTransport.handleRequest(req, res, body);
    return true;
  } catch (err) {
    console.error("[streamable-proxy] handler error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Internal Server Error",
        message: "Failed to handle streamable HTTP proxy request",
        details: err instanceof Error ? err.message : "Unknown error",
      })
    );
    return true;
  }
};