import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  ReadResourceRequestSchema,
  ResourceUpdatedNotificationSchema,
  ServerCapabilities,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const proxyServer = async ({
  client,
  server,
  serverCapabilities,
}: {
  client: Client;
  server: Server;
  serverCapabilities: ServerCapabilities;
}): Promise<void> => {
  try {
    // Add error handling wrapper
    const wrapHandler = <T extends any[], R>(
      handler: (...args: T) => Promise<R>,
      name: string
    ) => {
      return async (...args: T): Promise<R> => {
        try {
          return await handler(...args);
        } catch (error) {
          console.error(`[proxy-server] Error in ${name}:`, error);
          throw error;
        }
      };
    };

    if (serverCapabilities?.logging) {
      server.setNotificationHandler(
        LoggingMessageNotificationSchema,
        wrapHandler(async (args) => {
          return client.notification(args);
        }, 'server-logging-notification')
      );
      client.setNotificationHandler(
        LoggingMessageNotificationSchema,
        wrapHandler(async (args) => {
          return server.notification(args);
        }, 'client-logging-notification')
      );
    }

    if (serverCapabilities?.prompts) {
      server.setRequestHandler(
        GetPromptRequestSchema, 
        wrapHandler(async (args) => {
          return client.getPrompt(args.params);
        }, 'get-prompt')
      );

      server.setRequestHandler(
        ListPromptsRequestSchema, 
        wrapHandler(async (args) => {
          return client.listPrompts(args.params);
        }, 'list-prompts')
      );
    }

    if (serverCapabilities?.resources) {
      server.setRequestHandler(
        ListResourcesRequestSchema, 
        wrapHandler(async (args) => {
          return client.listResources(args.params);
        }, 'list-resources')
      );

      server.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        wrapHandler(async (args) => {
          return client.listResourceTemplates(args.params);
        }, 'list-resource-templates')
      );

      server.setRequestHandler(
        ReadResourceRequestSchema, 
        wrapHandler(async (args) => {
          return client.readResource(args.params);
        }, 'read-resource')
      );

      if (serverCapabilities?.resources.subscribe) {
        server.setNotificationHandler(
          ResourceUpdatedNotificationSchema,
          wrapHandler(async (args) => {
            return client.notification(args);
          }, 'resource-updated-notification')
        );

        server.setRequestHandler(
          SubscribeRequestSchema, 
          wrapHandler(async (args) => {
            return client.subscribeResource(args.params);
          }, 'subscribe-resource')
        );

        server.setRequestHandler(
          UnsubscribeRequestSchema, 
          wrapHandler(async (args) => {
            return client.unsubscribeResource(args.params);
          }, 'unsubscribe-resource')
        );
      }
    }

    if (serverCapabilities?.tools) {
      server.setRequestHandler(
        CallToolRequestSchema, 
        wrapHandler(async (args) => {
          return client.callTool(args.params);
        }, 'call-tool')
      );

      server.setRequestHandler(
        ListToolsRequestSchema, 
        wrapHandler(async (args) => {
          return client.listTools(args.params);
        }, 'list-tools')
      );
    }

    server.setRequestHandler(
      CompleteRequestSchema, 
      wrapHandler(async (args) => {
        return client.complete(args.params);
      }, 'complete')
    );
    
    console.log('[proxy-server] All handlers set up successfully');
  } catch (error) {
    console.error('[proxy-server] Error setting up proxy server:', error);
    throw error;
  }
};
