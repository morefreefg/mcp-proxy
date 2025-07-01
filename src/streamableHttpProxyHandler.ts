import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "node:crypto";
import { URL } from "url";

import { InMemoryEventStore } from "./InMemoryEventStore.js";
import { proxyServer } from "./proxyServer.js";

/** Connection state enumeration */
enum ConnectionState {
  INITIALIZING = 'initializing',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  ERROR = 'error'
}

/** Proxy connection interface */
interface ProxyConnection {
  client: Client;
  clientTransport: StreamableHTTPClientTransport;
  server: Server;
  serverTransport: StreamableHTTPServerTransport;
  state: ConnectionState;
  createdAt: number;
  lastUsed: number;
  sessionIds: Set<string>; // Track all session IDs using this connection
}

/** Active proxy connections: Map<connectionId, Connection> */
const activeProxyConnections: Record<string, ProxyConnection> = {};

/** Session to connection mapping: Map<sessionId, connectionId> */
const sessionToConnection: Record<string, string> = {};

/** Sessions being initialized, prevent concurrent initialization */
const initializingSessions = new Set<string>();

/** Connection cleanup timer */
let cleanupTimer: NodeJS.Timeout | null = null;

/** Start connection cleanup timer */
function startCleanupTimer() {
  if (cleanupTimer) return;
  
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    const CLEANUP_THRESHOLD = 30 * 60 * 1000; // 30 minutes
    
    for (const [connectionId, connection] of Object.entries(activeProxyConnections)) {
      if (now - connection.lastUsed > CLEANUP_THRESHOLD && connection.sessionIds.size === 0) {
        console.log(`[streamable-proxy] Cleaning up unused connection: ${connectionId}`);
        cleanupConnection(connectionId);
      }
    }
  }, 5 * 60 * 1000); // Check every 5 minutes
}

/** Clean up connection */
function cleanupConnection(connectionId: string) {
  const connection = activeProxyConnections[connectionId];
  if (!connection) return;
  
  try {
    // Clean up all related session mappings
    for (const sessionId of connection.sessionIds) {
      delete sessionToConnection[sessionId];
    }
    
    // Close connections
    connection.client.close().catch(err => 
      console.error(`[streamable-proxy] Error closing client for ${connectionId}:`, err)
    );
    
    connection.server.close().catch(err => 
      console.error(`[streamable-proxy] Error closing server for ${connectionId}:`, err)
    );
    
    // Remove from active connections
    delete activeProxyConnections[connectionId];
    
    console.log(`[streamable-proxy] Connection ${connectionId} cleaned up`);
  } catch (err) {
    console.error(`[streamable-proxy] Error during cleanup of ${connectionId}:`, err);
  }
}

/** Validate if connection is still valid */
async function validateConnection(connection: ProxyConnection): Promise<boolean> {
  try {
    if (connection.state !== ConnectionState.CONNECTED) {
      return false;
    }
    
    // Can add ping check or other health checks
    return true;
  } catch (err) {
    console.error('[streamable-proxy] Connection validation failed:', err);
    return false;
  }
}

/** Read and parse HTTP Body (may be empty) */
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

/** Core handler function */
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

    /* ---------- Debug logs ---------- */
    console.log(
      `[DEBUG] ${req.method} ${req.url}  session=${sessionIdHeader}  initialize=${isInitializeRequest(
        body
      )}`
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }

    /* ========== 1. Handle initialize ========= */
    if (isInitializeRequest(body)) {
      const initParams = (body as any).params ?? {};
      let sessionId = sessionIdHeader ?? randomUUID();
      const globalConnectionId = "global-mcp-connection";
      
      // Prevent concurrent initialization
      if (initializingSessions.has(sessionId)) {
        console.log(`[streamable-proxy] Session ${sessionId} is already initializing, waiting...`);
        // Simple wait mechanism, may need more complex queue in real applications
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Re-check if initialization is completed
        const connectionId = sessionToConnection[sessionId];
        if (connectionId && activeProxyConnections[connectionId]) {
          const connection = activeProxyConnections[connectionId];
          connection.lastUsed = Date.now();
          await connection.serverTransport.handleRequest(req, res, body);
          return true;
        }
      }
      
      initializingSessions.add(sessionId);
      
      try {
        /* Check if valid connection already exists */
        const existingConnectionId = sessionToConnection[sessionId];
        if (existingConnectionId && activeProxyConnections[existingConnectionId]) {
          const connection = activeProxyConnections[existingConnectionId];
          if (await validateConnection(connection)) {
            console.log(`[streamable-proxy] Session ${sessionId} reusing existing connection`);
            connection.lastUsed = Date.now();
            await connection.serverTransport.handleRequest(req, res, body);
            return true;
          } else {
            // Connection invalid, clean up
            console.log(`[streamable-proxy] Existing connection for ${sessionId} is invalid, cleaning up`);
            cleanupConnection(existingConnectionId);
          }
        }
        
        /* Check if there's a global connection that can be reused */
        if (activeProxyConnections[globalConnectionId]) {
          const globalConnection = activeProxyConnections[globalConnectionId];
          if (await validateConnection(globalConnection)) {
            console.log(`[streamable-proxy] Using existing global connection for session ${sessionId}`);
            sessionToConnection[sessionId] = globalConnectionId;
            globalConnection.sessionIds.add(sessionId);
            globalConnection.lastUsed = Date.now();
            await globalConnection.serverTransport.handleRequest(req, res, body);
            return true;
          } else {
            console.log(`[streamable-proxy] Global connection is invalid, cleaning up`);
            cleanupConnection(globalConnectionId);
          }
        }
        
        /* Create new connection */
        console.log(`[streamable-proxy] Creating new connection for session ${sessionId}`);
        
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
        
        let connectionId = sessionId;
        let serverCapabilities: any = {};
        let isGlobalConnection = false;
        
        // Create connection object
        const connection: ProxyConnection = {
          client,
          clientTransport,
          server: null as any, // Set later
          serverTransport: null as any, // Set later
          state: ConnectionState.INITIALIZING,
          createdAt: Date.now(),
          lastUsed: Date.now(),
          sessionIds: new Set([sessionId])
        };
        
        try {
          await client.connect(clientTransport);
          
          try {
            const response = await client.request(
              {
                method: "initialize",
                params: initParams
              },
              InitializeResultSchema
            );
            serverCapabilities = response.capabilities;
            connection.state = ConnectionState.CONNECTED;
          } catch (error: any) {
            if (error.message && error.message.includes("Server already initialized")) {
              console.log(`[streamable-proxy] Target server already initialized, creating global connection`);
              isGlobalConnection = true;
              connectionId = globalConnectionId;
              serverCapabilities = {
                tools: {},
                resources: {},
                prompts: {},
                logging: {}
              };
              connection.state = ConnectionState.CONNECTED;
            } else {
              connection.state = ConnectionState.ERROR;
              await client.close();
              throw error;
            }
          }
          
          /* Create serverTransport */
          const serverTransport = new StreamableHTTPServerTransport({
            eventStore: new InMemoryEventStore(),
            sessionIdGenerator: () => sessionId,
            onsessioninitialized: (sid) => {
              console.log(`[streamable-proxy] Session initialized with ID: ${sid}`);
            }
          });
          
          /* Create local Server */
          const server = new Server(
            { name: "mcp-proxy-server", version: "1.0.0" },
            { capabilities: serverCapabilities }
          );
          
          // Update connection object
          connection.server = server;
          connection.serverTransport = serverTransport;
          
          /* Connect server to transport first */
          await server.connect(serverTransport);
          
          /* Set up proxy */
          await proxyServer({ client, server, serverCapabilities });
          
          /* Save connection */
          activeProxyConnections[connectionId] = connection;
          sessionToConnection[sessionId] = connectionId;
          
          /* If global connection, ensure session mapping is correct */
          if (isGlobalConnection) {
            connection.sessionIds.clear();
            connection.sessionIds.add(sessionId);
          }
          
          /* Start cleanup timer */
          startCleanupTimer();
          
          /* Handle this initialize request */
          await serverTransport.handleRequest(req, res, body);
          
          console.log(
            `[streamable-proxy] Session ${sessionId} initialized${isGlobalConnection ? ' (global)' : ''}, capabilities keys: ${Object.keys(
              serverCapabilities || {}
            ).join(",")}`
          );
          
        } catch (error) {
          connection.state = ConnectionState.ERROR;
          await client.close().catch(err => 
            console.error('[streamable-proxy] Error closing client during error handling:', err)
          );
          throw error;
        }
        
      } finally {
        initializingSessions.delete(sessionId);
      }
      
      return true;
    }

    /* ========== 2. Subsequent requests ========= */
    if (!sessionIdHeader) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: -32000, message: "Missing session ID" },
          id: null,
          jsonrpc: "2.0",
        })
      );
      return true;
    }
    
    const connectionId = sessionToConnection[sessionIdHeader];
    const connection = connectionId ? activeProxyConnections[connectionId] : undefined;

    if (!connection) {
      /* Session does not exist - return JSON-RPC error */
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
    
    /* Validate connection state */
    if (!(await validateConnection(connection))) {
      console.log(`[streamable-proxy] Connection for session ${sessionIdHeader} is invalid`);
      cleanupConnection(connectionId);
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: -32000, message: "Connection lost, please reinitialize" },
          id: null,
          jsonrpc: "2.0",
        })
      );
      return true;
    }
    
    /* Update last used time */
    connection.lastUsed = Date.now();

    /* Hand over to saved serverTransport for continued processing */
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

/** Get connection status information (for debugging and monitoring) */
export function getConnectionStats() {
  const stats = {
    activeConnections: Object.keys(activeProxyConnections).length,
    activeSessions: Object.keys(sessionToConnection).length,
    initializingSessions: initializingSessions.size,
    connections: Object.entries(activeProxyConnections).map(([id, conn]) => ({
      id,
      state: conn.state,
      sessionCount: conn.sessionIds.size,
      createdAt: new Date(conn.createdAt).toISOString(),
      lastUsed: new Date(conn.lastUsed).toISOString(),
      sessionIds: Array.from(conn.sessionIds)
    }))
  };
  return stats;
}

/** Force cleanup all connections (for testing or restart) */
export function forceCleanupAllConnections() {
  console.log('[streamable-proxy] Force cleaning up all connections');
  
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  
  for (const connectionId of Object.keys(activeProxyConnections)) {
    cleanupConnection(connectionId);
  }
  
  // Clean up all mappings
  for (const sessionId of Object.keys(sessionToConnection)) {
    delete sessionToConnection[sessionId];
  }
  
  initializingSessions.clear();
}