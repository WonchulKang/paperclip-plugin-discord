import type { PluginContext } from "@paperclipai/plugin-sdk";
import { paperclipFetch } from "./paperclip-fetch.js";

/**
 * Resolve a company's issue prefix (`SOO`), the first path segment of every
 * dashboard deep link.
 *
 * Only link construction needs this — see `buildLinkBaseUrl` in formatters.ts
 * for why the API base URL must never carry the prefix.
 *
 * Two independent lookups, because neither one is available everywhere:
 *
 * 1. `ctx.companies.get()` — host-mediated, needs no credentials, but the host
 *    denies it unless the current invocation is scoped to that same company
 *    (`InvocationScopeDeniedError`). True at config delivery, false for
 *    anything arriving from the Discord gateway.
 * 2. `GET /api/companies/{id}` — works from any invocation, but in
 *    `authenticated` deployments it needs the board API key, which an install
 *    that never configured `paperclipBoardApiKeyRef` does not have.
 *
 * Every failure returns null rather than throwing: a missing prefix degrades
 * one button's URL to its previous (broken) form, and must never take the
 * notification — or worker bootstrap — down with it.
 *
 * Successful lookups are cached per company. Failures are not, so the next
 * bootstrap retries.
 */
const PREFIX_LOOKUP_TIMEOUT_MS = 5_000;

const cachedPrefixes = new Map<string, string>();

function normalizePrefix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveCompanyIssuePrefix(
  ctx: PluginContext,
  companyId: string,
  baseUrl: string,
  apiKey?: string,
): Promise<string | null> {
  if (!companyId || companyId === "default") return null;

  const cached = cachedPrefixes.get(companyId);
  if (cached) return cached;

  try {
    const company = await ctx.companies.get(companyId);
    const prefix = normalizePrefix(company?.issuePrefix);
    if (prefix) {
      cachedPrefixes.set(companyId, prefix);
      return prefix;
    }
  } catch (err) {
    // Expected whenever the invocation is not scoped to this company.
    ctx.logger.debug("Company issue prefix unavailable via ctx.companies.get; trying the API", {
      companyId,
      error: String(err),
    });
  }

  const api = baseUrl.trim().replace(/\/+$/, "");
  try {
    const response = await paperclipFetch(
      `${api}/api/companies/${encodeURIComponent(companyId)}`,
      { method: "GET", signal: AbortSignal.timeout(PREFIX_LOOKUP_TIMEOUT_MS) },
      apiKey || undefined,
    );
    const body = (await response.json()) as Record<string, unknown> | null;
    const prefix = normalizePrefix(body?.issuePrefix);
    if (prefix) {
      cachedPrefixes.set(companyId, prefix);
      return prefix;
    }
    ctx.logger.warn("Company response carried no issuePrefix; dashboard links will omit the company prefix", {
      companyId,
    });
  } catch (err) {
    ctx.logger.warn("Failed to resolve the company issue prefix; dashboard links will omit it", {
      companyId,
      error: String(err),
    });
  }

  return null;
}

/** Reset cached issue prefixes (for testing). */
export function _resetCompanyPrefixCache(): void {
  cachedPrefixes.clear();
}
