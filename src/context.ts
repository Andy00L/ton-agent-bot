import type { Bot } from "grammy";
import type OpenAI from "openai";
import type { TonAgentKit } from "@ton-agent-kit/core";
import type { SecretStore, FileStore } from "@ton-agent-kit/wallet-store";
import type { EndpointConfig } from "@ton-agent-kit/plugin-endpoints";

export interface BotContext {
  bot: Bot;
  secretStore: SecretStore;
  fileStore: FileStore;
  readOnlyAgent: TonAgentKit;
  chatHistories: Map<number, OpenAI.ChatCompletionMessageParam[]>;
  userAgents: Map<number, TonAgentKit>;
  userOpenAIClients: Map<number, { client: OpenAI; model: string }>;
  pendingApprovals: Map<string, { chatId: number; action: string; params: any; resolve: (approved: boolean) => void }>;
  endpointRoutes: Map<string, EndpointConfig>;
  userLocks: Map<number, boolean>;
  publicUrl: string;
  viewerBase: string;
  devAddress: string;
  devFriendlyAddr: string;
  network: "testnet" | "mainnet";
  x402Port: number;
}
