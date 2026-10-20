import { describe, it, expect, vi, afterEach } from "vitest";
import { formatApprovalCreated, humanizeApprovalType } from "../src/formatters.js";
import { enrichApprovalPayload } from "../src/worker.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

/**
 * SOO-88: the approval card showed only bookkeeping.
 *
 * `approval.created` is the host's activity-log entry, so what reaches the
 * plugin is `{ type, issueIds }` plus the log envelope (`agentId`, `runId`,
 * `responsibleUserId`). The board saw an untitled "Approval Requested" with a
 * raw `request_board_approval`, a UUID under "Linked Issues" and a
 * `responsibleUserId` UUID — nothing about what it was approving. The
 * requester's title and description live on the approval row, which the event
 * never carries.
 */

// The payload the host actually delivered for approval dc31f479 on 2026-10-20.
function makeApprovalEvent(payload: Record<string, unknown> = {}): PluginEvent {
  return {
    eventType: "approval.created",
    eventId: "evt-1",
    companyId: "co-1",
    entityId: "apr-1",
    entityType: "approval",
    actorId: "agent-uuid",
    occurredAt: "2026-10-20T10:50:13Z",
    payload: {
      type: "request_board_approval",
      issueIds: ["cd846034-084c-454e-80a3-719e3d9b674f"],
      agentId: "agent-uuid",
      runId: "run-uuid",
      responsibleUserId: "2okPa93occpyYOxJ92FzVQKDxjncP3Y5",
      ...payload,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("formatApprovalCreated", () => {
  it("keeps the activity-log envelope off the card", () => {
    const msg = formatApprovalCreated(makeApprovalEvent());
    const names = msg.embeds?.[0]?.fields?.map((f) => f.name) ?? [];
    expect(names).not.toContain("responsibleUserId");
    expect(names).not.toContain("agentId");
    expect(names).not.toContain("runId");
  });

  it("never prints raw issue UUIDs", () => {
    const msg = formatApprovalCreated(makeApprovalEvent());
    const values = (msg.embeds?.[0]?.fields ?? []).map((f) => f.value).join("\n");
    expect(values).not.toContain("cd846034-084c-454e-80a3-719e3d9b674f");
  });

  it("humanizes the approval type", () => {
    const msg = formatApprovalCreated(makeApprovalEvent());
    const type = msg.embeds?.[0]?.fields?.find((f) => f.name === "Type");
    expect(type?.value).toBe("`Board Approval`");
    expect(humanizeApprovalType("deploy")).toBe("deploy");
  });

  it("shows the requester's title and description", () => {
    const msg = formatApprovalCreated(
      makeApprovalEvent({
        title: "SOO-84 배포 사인오프",
        description: "포크 main 전체가 라이브됐습니다. 동의하시면 승인해 주세요.",
        agentName: "SWTeamLeader",
      }),
    );
    expect(msg.embeds?.[0]?.title).toBe("Approval: SOO-84 배포 사인오프");
    expect(msg.embeds?.[0]?.description).toContain("승인해 주세요");
    const requester = msg.embeds?.[0]?.fields?.find((f) => f.name === "Requested by");
    expect(requester?.value).toBe("SWTeamLeader");
  });

  it("truncates an over-long description instead of letting Discord reject the embed", () => {
    const msg = formatApprovalCreated(
      makeApprovalEvent({ description: "x".repeat(5000) }),
    );
    expect(msg.embeds?.[0]?.description?.length).toBe(2000);
    expect(msg.embeds?.[0]?.description?.endsWith("…")).toBe(true);
  });

  it("renders enriched linked issues by identifier and title", () => {
    const msg = formatApprovalCreated(
      makeApprovalEvent({
        linkedIssues: [
          { id: "iss-1", identifier: "SOO-84", title: "플러그인 재설치", status: "in_progress", priority: "high" },
        ],
      }),
    );
    const linked = msg.embeds?.[0]?.fields?.find((f) => f.name === "Linked Issue");
    expect(linked?.value).toContain("**SOO-84**");
    expect(linked?.value).toContain("플러그인 재설치");
    expect(linked?.value).toContain("In Progress");
    expect(linked?.value).toContain("High");
  });

  it("adds a deep link to the sole linked issue", () => {
    const msg = formatApprovalCreated(
      makeApprovalEvent({
        linkedIssues: [{ id: "iss-1", identifier: "SOO-84", title: "플러그인 재설치" }],
      }),
      "https://app.paperclip.dev/SOO",
    );
    const buttons = msg.components?.[0]?.components ?? [];
    expect(buttons.map((b) => b.label)).toEqual(["Approve", "Reject", "View", "View SOO-84"]);
    expect(buttons[3]?.url).toBe("https://app.paperclip.dev/SOO/issues/iss-1");
  });

  it("omits the issue deep link when several issues are linked", () => {
    const msg = formatApprovalCreated(
      makeApprovalEvent({
        linkedIssues: [
          { id: "iss-1", identifier: "SOO-84", title: "A" },
          { id: "iss-2", identifier: "SOO-85", title: "B" },
        ],
      }),
      "https://app.paperclip.dev/SOO",
    );
    expect(msg.components?.[0]?.components).toHaveLength(3);
    const linked = msg.embeds?.[0]?.fields?.find((f) => f.name === "Linked Issues (2)");
    expect(linked?.value).toContain("SOO-85");
  });

  it("still surfaces whatever else the requester attached", () => {
    const msg = formatApprovalCreated(
      makeApprovalEvent({ sideEffects: "none", deployedCommit: "0ad2520" }),
    );
    const names = msg.embeds?.[0]?.fields?.map((f) => f.name) ?? [];
    expect(names).toContain("sideEffects");
    expect(names).toContain("deployedCommit");
  });
});

// ---------------------------------------------------------------------------

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    agents: { list: vi.fn().mockResolvedValue([]) },
    issues: { get: vi.fn().mockResolvedValue(null) },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const OPTS = { baseUrl: "https://app.paperclip.dev", apiKey: "board-key" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubApprovalFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 403,
    statusText: ok ? "OK" : "Forbidden",
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("enrichApprovalPayload", () => {
  it("merges the approval's own payload into the event payload", async () => {
    stubApprovalFetch({
      id: "apr-1",
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: "agent-uuid",
      payload: { title: "배포 사인오프", description: "승인해 주세요", sideEffects: "none" },
    });
    const result = await enrichApprovalPayload(makeCtx(), makeApprovalEvent(), OPTS);
    expect(result.title).toBe("배포 사인오프");
    expect(result.description).toBe("승인해 주세요");
    expect(result.sideEffects).toBe("none");
  });

  it("prefers the host-mediated approvals client when the install granted it", async () => {
    const get = vi.fn().mockResolvedValue({ id: "apr-1", payload: { title: "via sdk" } });
    const fetchMock = stubApprovalFetch({});
    const result = await enrichApprovalPayload(
      makeCtx({ approvals: { get } }),
      makeApprovalEvent(),
      OPTS,
    );
    expect(get).toHaveBeenCalledWith("apr-1", "co-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.title).toBe("via sdk");
  });

  it("resolves linked issue UUIDs into identifiers and titles", async () => {
    stubApprovalFetch({ id: "apr-1", payload: {} });
    const ctx = makeCtx({
      issues: {
        get: vi.fn().mockResolvedValue({
          id: "cd846034-084c-454e-80a3-719e3d9b674f",
          identifier: "SOO-84",
          title: "플러그인 재설치",
          status: "in_progress",
          priority: "high",
        }),
      },
    });
    const result = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);
    expect(result.linkedIssues).toEqual([
      {
        id: "cd846034-084c-454e-80a3-719e3d9b674f",
        identifier: "SOO-84",
        title: "플러그인 재설치",
        status: "in_progress",
        priority: "high",
      },
    ]);
  });

  it("names the requesting agent", async () => {
    stubApprovalFetch({ id: "apr-1", payload: {} });
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockResolvedValue([
          { id: "other", name: "Decoy" },
          { id: "agent-uuid", name: "SWTeamLeader" },
        ]),
      },
    });
    const result = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);
    expect(result.agentName).toBe("SWTeamLeader");
  });

  // An install without a board API key, or a host that denies approvals.read,
  // must still get the notification — just with less on it.
  it("returns the original payload when the approval cannot be read", async () => {
    stubApprovalFetch({ error: "forbidden" }, false);
    const ctx = makeCtx();
    const result = await enrichApprovalPayload(ctx, makeApprovalEvent(), OPTS);
    expect(result.type).toBe("request_board_approval");
    expect(result.title).toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalled();
  });
});
