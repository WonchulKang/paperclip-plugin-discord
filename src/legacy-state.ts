import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Read plugin state that older versions wrote under the literal company scope
 * `"default"`.
 *
 * `"default"` is not a real company ID, so the host rejects the read rather
 * than returning null — on a proactive invocation it is not in the plugin's
 * authorized company set, and the rejection surfaces as a thrown error. A
 * missing legacy record is not a failure, so swallow it: callers treat it the
 * same as "no legacy value". Letting it propagate is what made the escalation
 * timeout job fail on every run, because its pending-ID sweep always consulted
 * the legacy scope.
 */
export async function readLegacyDefaultScopeState(
  ctx: PluginContext,
  stateKey: string,
): Promise<unknown> {
  try {
    return await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey });
  } catch (err) {
    ctx.logger.debug("Legacy 'default'-scope state read was refused", {
      stateKey,
      error: String(err),
    });
    return null;
  }
}
