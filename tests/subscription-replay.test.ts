import assert from "node:assert/strict";
import { it } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { createModels, InMemoryCredentialStore, normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { subscriptionAliases } from "../src/agent/connected-providers.ts";

const responsesReply = 'data: {"type":"response.created","response":{"id":"response-test","status":"in_progress","output":[]}}\n\ndata: {"type":"response.completed","response":{"id":"response-test","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
const anthropicReply = [
	["message_start", { type: "message_start", message: { id: "msg-test", type: "message", role: "assistant", content: [], model: "test", usage: { input_tokens: 1, output_tokens: 0 } } }],
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
	["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

for (const providerId of ["subscription-openai-codex", "subscription-anthropic", "subscription-xai"] as const) {
	it(`${providerId} replays its signed reasoning but drops reasoning from a different model`, async () => {
		const credentials = new InMemoryCredentialStore();
		const access = providerId === "subscription-openai-codex"
			? `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`
			: "fixture-token";
		await credentials.modify(providerId, async () => ({ type: "oauth", access, refresh: "fixture-refresh", expires: Date.now() + 3_600_000 }));
		const models = createModels({ credentials });
		const provider = subscriptionAliases(builtinProviders()).find((entry) => entry.id === providerId)!;
		models.setProvider(provider);
		const model = models.getModels(providerId).find((entry) => entry.reasoning)!;
		const anthropic = model.api === "anthropic-messages";
		const signature = anthropic ? "signed-reasoning" : JSON.stringify({ id: "rs-replay", type: "reasoning", summary: [], encrypted_content: "encrypted-reasoning" });
		const toolId = anthropic ? "tool-replay" : "call_replay|fc_replay";
		const previous: AssistantMessage = {
			role: "assistant", provider: providerId, api: model.api, model: model.id, timestamp: 1, stopReason: "toolUse",
			content: [{ type: "thinking", thinking: "Prior reasoning", thinkingSignature: signature }, { type: "toolCall", id: toolId, name: "lookup", arguments: {} }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const foreign: AssistantMessage = { ...previous, model: "different-model", content: [{ type: "thinking", thinking: "Foreign reasoning", thinkingSignature: "foreign-signature" }, { type: "text", text: "Foreign answer" }] };
		const context = normalizeContext({ messages: [
			{ role: "user", content: "First question", timestamp: 0 }, previous,
			{ role: "toolResult", toolCallId: toolId, toolName: "lookup", content: [{ type: "text", text: "Lookup result" }], isError: false, timestamp: 2 },
			{ role: "user", content: "Second question", timestamp: 2 }, foreign,
			{ role: "user", content: "Continue", timestamp: 3 },
		] });
		const before = structuredClone(context);
		let body: Record<string, unknown> | undefined;
		const options = { transport: "sse" as const, maxRetries: 0, fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const request = new Request(input, init);
			const bytes = Buffer.from(await request.arrayBuffer());
			const text = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString();
			body = JSON.parse(text) as Record<string, unknown>;
			return new Response(anthropic ? anthropicReply : responsesReply, { headers: { "content-type": "text/event-stream" } });
		} };
		// Both native SDK entry points must preserve their own protocol's replay data.
		const result = anthropic ? await models.complete(model, context, options) : await models.completeSimple(model, context, options);
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(result.provider, providerId);
		assert.ok(body, "Native transport was not called");
		if (anthropic) {
			const messages = body.messages as { role: string; content: { type: string; signature?: string }[] }[];
			assert.ok(messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "thinking" && block.signature === signature)), "Signed Claude reasoning was lost before replay");
		} else {
			const items = body.input as { type: string; id?: string; call_id?: string; encrypted_content?: string }[];
			assert.ok(items.some((item) => item.type === "reasoning" && item.encrypted_content === "encrypted-reasoning"), "Encrypted reasoning was lost before replay");
			assert.ok(items.some((item) => item.type === "function_call" && item.id === "fc_replay" && item.call_id === "call_replay"), "Native tool-call item identity was lost before replay");
			assert.ok(items.some((item) => item.type === "function_call_output" && item.call_id === "call_replay"), "Tool result no longer matches its original call");
		}
		assert.ok(!JSON.stringify(body).includes("foreign-signature"), "Another model's signature must not be replayed");
		assert.deepEqual(context, before, "Provider conversion must not mutate stored transcript provenance");
	});
}
