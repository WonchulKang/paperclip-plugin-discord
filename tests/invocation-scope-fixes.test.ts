import { describe, it, expect, vi, beforeEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Invocation-scope regressions.
//
// The host authorizes a plugin call one of two ways: against the invocation the
// worker echoes back, or — when the worker echoes none — against the set of
// companies the plugin is configured for ("proactive"). Three separate bugs all
// surfaced as the same host error, which made them look like one:
//
//   Plugin "..." is not allowed to perform "agents.list": the worker
//   referenced a missing, expired, or unknown invocation scope
//
//   1. The gateway was connected inside the `configChanged` invocation, so its
//      callbacks inherited that invocation's async context and kept echoing its
//      ID after the host had cleared it.
//   2. `resolveCompanyId()` fell back to the literal string "default" because
//      the only other source was `companies.list()`, which the host refuses on
//      proactive invocations. Every `{ companyId: "default" }` call was then
//      rejected.
//   3. Reads of the legacy `"default"` company scope THREW instead of returning
//      null, for the same reason — which failed the whole escalation job.
//
// The mocks below copy the host where it bites: `companies.list()` rejects, and
// a state read scoped to "default" rejects rather than answering null.
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => ({ capturedDefinitions: [] as any[] }));

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

const { gatewayConnects } = vi.hoisted(() => ({ gatewayConnects: [] as any[] }));

/**
 * The host's invocation context. The SDK runs each RPC handler inside one of
 * these; anything that inherits it echoes the invocation ID back to the host.
 */
const hostInvocationContext = new AsyncLocalStorage<{ invocationId: string }>();

vi.mock("../src/gateway.js", () => ({
  connectGateway: vi.fn(async (_ctx: any, token: string, onInteraction: any) => {
    gatewayConnects.push({
      token,
      onInteraction,
      // What the host would see echoed back on every callback from this socket.
      inheritedInvocation: hostInvocationContext.getStore() ?? null,
    });
    return { close: () => {} };
  }),
}));

import { _resetRuntimeForTests } from "../src/worker.js";
import { resolveCompanyId, _resetCompanyIdCache } from "../src/company-resolver.js";
import { collectPendingEscalationIds, getEscalation } from "../src/escalation-state.js";
import { handleInteraction, type CommandContext } from "../src/commands.js";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";

const PROACTIVE_WILDCARD_DENIED =
  'not allowed to perform "companies.list": a wildcard is not granted proactively';
const DEFAULT_SCOPE_DENIED =
  'not allowed to perform "state.get": company "default" is not in the plugin\'s authorized set';

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

function storedConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    defaultChannelId: "1490608926423646298",
    // Empty: slash-command registration is a Discord REST call, out of scope here.
    defaultGuildId: "",
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableInbound: false,
    enableCommands: false,
    digestMode: "off",
    ...overrides,
  };
}

/** A governed host that refuses wildcards and the legacy "default" scope. */
function buildCtx(overrides: Record<string, unknown> = {}) {
  const stateStore = new Map<string, unknown>();
  return {
    config: { get: vi.fn(async () => storedConfig()) },
    secrets: { resolve: vi.fn(async () => "discord-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: any) => {
        if (key.scopeKind === "company" && key.scopeId === "default") {
          throw new Error(DEFAULT_SCOPE_DENIED);
        }
        return stateStore.get(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`) ?? null;
      }),
      set: vi.fn(async (key: any, value: unknown) => {
        stateStore.set(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`, value);
      }),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn() },
    companies: {
      list: vi.fn(async () => {
        throw new Error(PROACTIVE_WILDCARD_DENIED);
      }),
      // A single-company read IS allowed inside that company's own invocation,
      // which is where the issue-prefix lookup runs.
      get: vi.fn(async (companyId: string) => ({ id: companyId, name: "Acme", issuePrefix: "ACME" })),
    },
    agents: { list: vi.fn(async () => []), invoke: vi.fn() },
    issues: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      update: vi.fn(async () => undefined),
      listComments: vi.fn(async () => []),
    },
    http: { fetch: vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" })) },
    _stateStore: stateStore,
    ...overrides,
  } as any;
}

function cmdCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    baseUrl: "http://localhost:3100",
    companyId: COMPANY,
    token: "discord-bot-token",
    defaultChannelId: "chan-1",
    ...overrides,
  };
}

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  gatewayConnects.length = 0;
  vi.clearAllMocks();
});

describe("gateway callbacks do not inherit the configChanged invocation", () => {
  it("connects outside the invocation that delivered the configuration", async () => {
    const ctx = buildCtx();
    await definition().setup(ctx);

    // The host runs the RPC inside an invocation context, then clears the
    // invocation as soon as the RPC returns.
    await hostInvocationContext.run({ invocationId: "inv-1" }, async () => {
      await definition().onConfigChanged(storedConfig(), { companyId: COMPANY });
    });

    expect(gatewayConnects).toHaveLength(1);
    // A non-null value here is the bug: every later callback would echo an
    // invocation the host has already deleted.
    expect(gatewayConnects[0].inheritedInvocation).toBeNull();
  });
});

describe("resolveCompanyId never degrades to the string \"default\"", () => {
  it("uses the configured company instead of calling companies.list", async () => {
    const ctx = buildCtx();

    await expect(resolveCompanyId(ctx, COMPANY)).resolves.toBe(COMPANY);
    expect(ctx.companies.list).not.toHaveBeenCalled();
  });

  it("still prefers an explicit /clip connect binding", async () => {
    const ctx = buildCtx();
    const connected = "99999999-9999-9999-9999-999999999999";
    ctx.state.get = vi.fn(async (key: any) =>
      key.scopeKind === "instance" && key.stateKey === "company_default"
        ? { companyId: connected }
        : null,
    );

    await expect(resolveCompanyId(ctx, COMPANY)).resolves.toBe(connected);
  });

  it("scopes /clip status to the real company when companies.list is refused", async () => {
    const ctx = buildCtx();

    await handleInteraction(
      ctx,
      {
        type: 2,
        data: { name: "clip", options: [{ name: "status" }] },
        member: { user: { username: "boarduser" } },
      } as any,
      cmdCtx({ pluginCtx: ctx }),
    );

    expect(ctx.agents.list).toHaveBeenCalled();
    for (const call of ctx.agents.list.mock.calls) {
      expect(call[0]?.companyId).toBe(COMPANY);
    }
  });
});

describe("issue buttons work without company enumeration", () => {
  it("reopens through the configured company when companies.list is refused", async () => {
    const ctx = buildCtx();
    ctx.issues.get = vi.fn(async (issueId: string, companyId: string) =>
      companyId === COMPANY ? { id: issueId, status: "done" } : null,
    );

    await handleInteraction(
      ctx,
      {
        type: 3,
        data: { name: "button", custom_id: "issue_reopen_issue-1" },
        member: { user: { username: "boarduser" } },
      } as any,
      cmdCtx({ pluginCtx: ctx }),
    );

    expect(ctx.issues.update).toHaveBeenCalledWith("issue-1", { status: "todo" }, COMPANY);
  });
});

describe("legacy \"default\"-scope state reads are tolerated", () => {
  it("collects pending escalations even though the legacy scope is refused", async () => {
    const ctx = buildCtx();
    ctx._stateStore.set(`company:${COMPANY}:escalation_pending_ids`, ["esc_1", "esc_2"]);

    await expect(collectPendingEscalationIds(ctx, COMPANY)).resolves.toEqual(["esc_1", "esc_2"]);
  });

  it("returns null from the escalation fallback instead of throwing", async () => {
    const ctx = buildCtx();

    await expect(getEscalation(ctx, "esc_missing", COMPANY)).resolves.toBeNull();
  });
});
