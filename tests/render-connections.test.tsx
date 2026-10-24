import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it, type TestContext } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import {
	ConnectionsSection,
	CustomProviderEditor,
	LoginAttemptPanel,
	LoginPromptForm,
	buildCustomRequest,
	cancelPendingLogins,
	draftFromStatus,
	emptyCustomDraft,
	namespaceCustomId,
	safeExternalUrl,
	subscriptionLine,
} from "../components/settings/connections-section.tsx";
import { hasAvailableProvider, hasProviderKey } from "../components/setup-cta.tsx";
import { SUBSCRIPTION_PROVIDERS, type LoginAttemptView } from "../src/core/index.ts";

const noop = () => {};

function validDraft() {
	const d = emptyCustomDraft();
	d.id = "local";
	d.name = "Local";
	d.baseUrl = "http://localhost:1234/v1";
	d.keyless = true;
	d.models = [{ ...d.models[0]!, id: "m1", contextWindow: "8000", maxTokens: "1000" }];
	return d;
}

describe("connections pure helpers", () => {
	it("namespaces ids", () => {
		assert.equal(namespaceCustomId("My Proxy"), "custom-my-proxy");
		assert.equal(namespaceCustomId("custom-x"), "custom-x");
		assert.equal(namespaceCustomId("  "), "");
	});
	it("only http(s) links", () => {
		assert.equal(safeExternalUrl("javascript:alert(1)"), null);
		assert.equal(safeExternalUrl("nope"), null);
		assert.ok(safeExternalUrl("https://example.com/a"));
	});
	it("pending status is not disconnected", () => {
		assert.equal(subscriptionLine(undefined), "checking");
		assert.equal(subscriptionLine({ id: "subscription-xai", name: "x", connected: false }), "not connected");
	});
	it("builds a keyless request without apiKey", () => {
		const r = buildCustomRequest(validDraft(), false);
		assert.ok(r.ok);
		if (r.ok) {
			assert.equal(r.body.provider.id, "custom-local");
			assert.equal(r.body.apiKey, undefined);
			assert.equal(r.body.provider.models[0]!.cost, undefined);
		}
	});
	it("requires a key unless keyless or stored", () => {
		const d = validDraft();
		d.keyless = false;
		assert.equal(buildCustomRequest(d, false).ok, false);
		assert.equal(buildCustomRequest(d, true).ok, true);
		d.apiKey = " k ";
		const r = buildCustomRequest(d, false);
		assert.ok(r.ok && r.body.apiKey === "k");
	});
	it("validates models and costs", () => {
		const d = validDraft();
		d.models[0]!.contextWindow = "abc";
		assert.equal(buildCustomRequest(d, false).ok, false);
		const e = validDraft();
		e.models[0]!.costInput = "-1";
		assert.equal(buildCustomRequest(e, false).ok, false);
		const f = validDraft();
		f.models.push({ ...f.models[0]! });
		assert.equal(buildCustomRequest(f, false).ok, false);
		const g = validDraft();
		g.baseUrl = "ftp://x";
		assert.equal(buildCustomRequest(g, false).ok, false);
	});
	it("round-trips a status into a draft", () => {
		const d = draftFromStatus({
			id: "custom-a",
			name: "A",
			baseUrl: "https://a/v1",
			api: "anthropic-messages",
			keyless: false,
			keyPresent: true,
			models: [
				{ id: "m", name: "M", contextWindow: 10, maxTokens: 5, input: ["text", "image"], reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
			],
		});
		assert.equal(d.apiKey, "");
		assert.equal(d.models[0]!.image, true);
		const r = buildCustomRequest(d, true);
		assert.ok(r.ok && r.body.provider.models[0]!.cost?.output === 2);
	});
	it("availability helper; hasProviderKey unchanged", () => {
		assert.equal(hasAvailableProvider([{ keyPresent: false }, { keyPresent: true }]), true);
		assert.equal(hasAvailableProvider([]), false);
		assert.equal(hasProviderKey([], undefined), false);
	});
});

describe("unmount cancel", () => {
	it("cancels only pending attempts with keepalive DELETE", () => {
		const calls: [string, RequestInit][] = [];
		const base = { providerId: "subscription-xai" as const, events: [] as LoginAttemptView["events"] };
		const ids = cancelPendingLogins(
			{
				a: { ...base, id: "p1", state: "pending" },
				b: { ...base, id: "f1", state: "failed" },
			},
			async (u, i) => void calls.push([u, i]),
		);
		assert.deepEqual(ids, ["p1"]);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]![0], "/api/connections/login/p1");
		assert.equal(calls[0]![1].method, "DELETE");
		assert.equal(calls[0]![1].keepalive, true);
		assert.equal((calls[0]![1].headers as Record<string, string>)["X-LearnHarness-Connections"], "1");
	});
});

describe("connections SSR", () => {
	it("section lists the three subscriptions in a checking state", () => {
		const html = renderToStaticMarkup(<ConnectionsSection />);
		for (const p of ["openai-codex", "anthropic", "xai"]) assert.ok(html.includes(`subscription-${p}-status`));
		assert.ok(html.includes("checking"));
		assert.ok(!html.includes("not connected"));
		assert.ok(html.includes('data-testid="custom-add"'));
	});
	it("editor: password key, keyless toggle, model rows", () => {
		const html = renderToStaticMarkup(<CustomProviderEditor initial={emptyCustomDraft()} keyStored={false} onSaved={noop} onCancel={noop} />);
		assert.ok(html.includes('type="password"'));
		assert.ok(html.includes('data-testid="custom-keyless"'));
		assert.ok(html.includes('data-testid="custom-model-0"'));
		assert.ok(html.includes("anthropic-messages"));
	});
	it("attempt panel: external links, device code, error", () => {
		const attempt: LoginAttemptView = {
			id: "a",
			providerId: "subscription-xai",
			state: "pending",
			events: [
				{ type: "auth_url", url: "https://auth.example/x" },
				{ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device" },
			],
		};
		const html = renderToStaticMarkup(<LoginAttemptPanel attempt={attempt} busy={false} onAnswer={noop} onCancel={noop} />);
		assert.ok(html.includes('target="_blank"') && html.includes('rel="noopener noreferrer"'));
		assert.ok(html.includes("ABCD-1234"));
		assert.ok(html.includes('data-testid="login-cancel"'));
		const bad = renderToStaticMarkup(
			<LoginAttemptPanel attempt={{ ...attempt, events: [{ type: "auth_url", url: "javascript:alert(1)" }] }} busy={false} onAnswer={noop} onCancel={noop} />,
		);
		assert.ok(!bad.includes("javascript:"));
		const failed = renderToStaticMarkup(
			<LoginAttemptPanel attempt={{ ...attempt, state: "failed", events: [], error: "Sign-in failed." }} busy={false} onAnswer={noop} onCancel={noop} />,
		);
		assert.ok(failed.includes('data-testid="login-error"'));
	});
	it("prompt types", () => {
		const secret = renderToStaticMarkup(<LoginPromptForm prompt={{ id: "p", type: "secret", message: "Token" }} busy={false} onSubmit={noop} />);
		assert.ok(secret.includes('type="password"'));
		const sel = renderToStaticMarkup(
			<LoginPromptForm prompt={{ id: "p", type: "select", message: "Pick", options: [{ id: "o", label: "Opt" }] }} busy={false} onSubmit={noop} />,
		);
		assert.ok(sel.includes("<select") && sel.includes("Opt"));
		const manual = renderToStaticMarkup(<LoginPromptForm prompt={{ id: "p", type: "manual_code", message: "Code" }} busy={false} onSubmit={noop} />);
		assert.ok(manual.includes("Paste the code"));
	});
});


// Mount the real connection controls. Only the HTTP boundary and interval
// clock are replaced, so no account login or credential write can escape.
describe("subscription login interactions", () => {
	const dom = parseHTML("<html><body></body></html>");
	const originalFetch = globalThis.fetch;
	let root: Root | null = null;
	let host: HTMLDivElement | null = null;

	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((r) => { resolve = r; });
		return { promise, resolve };
	}
	function attempt(id: string, promptId = "method"): LoginAttemptView {
		return {
			id,
			providerId: "subscription-openai-codex",
			state: "pending",
			events: [],
			prompt: {
				id: promptId,
				type: "select",
				message: promptId === "method" ? "Choose login method" : "Next login prompt",
				options: [{ id: "browser", label: "Browser login" }],
			},
		};
	}
	function ended(id: string, state: "cancelled" | "connected") {
		return { ...attempt(id), state, prompt: undefined };
	}
	async function mount(
		t: TestContext,
		login: (path: string, init: RequestInit | undefined) => Promise<Response>,
		connected = () => false,
	) {
		Object.assign(globalThis, {
			window: dom.window,
			document: dom.document,
			Element: dom.window.Element,
			HTMLElement: dom.window.HTMLElement,
			CustomEvent: dom.window.CustomEvent,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		t.mock.timers.enable({ apis: ["setInterval"] });
		globalThis.fetch = async (input, init) => {
			const path = String(input);
			if (path === "/api/connections/subscriptions" && !init?.method) {
				return Response.json({ subscriptions: SUBSCRIPTION_PROVIDERS.map((p) => ({ id: p.id, name: p.name, connected: p.id === "subscription-openai-codex" && connected() })) });
			}
			if (path === "/api/connections/custom" && !init?.method) return Response.json({ providers: [] });
			return login(path, init);
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => { root!.render(<ConnectionsSection />); });
	}
	function element(selector: string): HTMLElement {
		const el = host?.querySelector<HTMLElement>(selector);
		assert.ok(el, selector);
		return el;
	}
	async function click(selector: string) {
		await act(async () => { element(selector).click(); });
	}
	async function tick(t: TestContext, ms = 1500) {
		await act(async () => { t.mock.timers.tick(ms); });
	}
	afterEach(async () => {
		await act(async () => { root?.unmount(); });
		root = null;
		host?.remove();
		host = null;
		globalThis.fetch = originalFetch;
	});

	it("cancels a pending start returned after unmount", async (t) => {
		const start = deferred<Response>();
		const cancelled: string[] = [];
		await mount(t, async (path, init) => {
			if (init?.method === "POST") return start.promise;
			assert.equal(init?.method, "DELETE");
			cancelled.push(path);
			return Response.json(ended("late", "cancelled"));
		});
		await click('[data-testid="subscription-openai-codex-connect"]');
		await act(async () => { root!.unmount(); root = null; });
		await act(async () => { start.resolve(Response.json(attempt("late"))); });
		assert.deepEqual(cancelled, ["/api/connections/login/late"]);
	});

	it("does not restore a cancelled attempt over a new login", async (t) => {
		const poll = deferred<Response>();
		let starts = 0;
		await mount(t, async (_path, init) => {
			if (init?.method === "POST") return Response.json(attempt(++starts === 1 ? "old" : "new", starts === 1 ? "method" : "next"));
			if (init?.method === "DELETE") return Response.json(ended("old", "cancelled"));
			return poll.promise;
		});
		await click('[data-testid="subscription-openai-codex-connect"]');
		await tick(t);
		await click('[data-testid="login-cancel"]');
		await click('[data-testid="subscription-openai-codex-connect"]');
		await act(async () => { poll.resolve(Response.json(attempt("old"))); });
		assert.equal(element('[data-testid="login-prompt"] label').textContent, "Next login prompt");
	});

	it("keeps the newer prompt after answering and allows only one pending poll", async (t) => {
		const poll = deferred<Response>();
		let reads = 0;
		await mount(t, async (path, init) => {
			if (init?.method === "POST") return Response.json(attempt("login", path === "/api/connections/login" ? "method" : "next"));
			if (init?.method === "DELETE") return Response.json(ended("login", "cancelled"));
			reads++;
			return poll.promise;
		});
		await click('[data-testid="subscription-openai-codex-connect"]');
		await tick(t, 4500);
		assert.equal(reads, 1, "a slow poll must not overlap another poll for the same attempt");
		await act(async () => {
			const select = element('[data-testid="login-prompt"] select');
			Object.defineProperty(select, "value", { configurable: true, value: "browser" });
			select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		assert.equal(element('[data-testid="login-prompt"] label').textContent, "Next login prompt");
		await act(async () => { poll.resolve(Response.json(attempt("login"))); });
		assert.equal(element('[data-testid="login-prompt"] label').textContent, "Next login prompt");
	});

	it("keeps the current attempt and reports a failed cancellation", async (t) => {
		await mount(t, async (_path, init) => {
			if (init?.method === "DELETE") return Response.json({ error: "Could not cancel." }, { status: 500 });
			return Response.json(attempt("login"));
		});
		await click('[data-testid="subscription-openai-codex-connect"]');
		await click('[data-testid="login-cancel"]');
		assert.ok(element('[data-testid="login-prompt"]'));
		assert.equal(element('[data-testid="subscription-openai-codex-error"]').textContent, "Could not cancel.");
		assert.equal((element('[data-testid="subscription-openai-codex-connect"]') as HTMLButtonElement).disabled, true);
	});

	it("refreshes status and catalog consumers if cancellation returns connected", async (t) => {
		let connected = false;
		const saved: string[] = [];
		const listener = (event: Event) => saved.push((event as CustomEvent<{ section: string }>).detail.section);
		await mount(t, async (_path, init) => {
			if (init?.method === "DELETE") {
				connected = true;
				return Response.json(ended("login", "connected"));
			}
			return Response.json(attempt("login"));
		}, () => connected);
		window.addEventListener("lh:settings-saved", listener);
		try {
			await click('[data-testid="subscription-openai-codex-connect"]');
			await click('[data-testid="login-cancel"]');
			assert.equal(element('[data-testid="subscription-openai-codex-status"]').textContent, "connected");
			assert.ok(element('[data-testid="subscription-openai-codex-disconnect"]'));
			assert.deepEqual(saved, ["keys", "models"]);
		} finally {
			window.removeEventListener("lh:settings-saved", listener);
		}
	});
});
