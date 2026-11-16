// Buzz's attribution on a Claude process's own gateway connection: the
// person's settings choose the endpoint and sign-in, and Buzz only adds its
// context headers to `ANTHROPIC_CUSTOM_HEADERS` through Claude's flag
// settings, between turns. Composition and eligibility are pure; the
// process (`claude.ts`) reads its settings and applies the result. Nothing
// here logs a setting's value, which may hold a credential.
import {
  type GatewayHeaders,
  type GatewayProfile,
  isReservedHeader,
} from "../../features/agents/gateway/contract";

/** The harness Claude declares to the gateway, its descriptor upstream key. */
export const HARNESS = "claude-code";

/** What has Claude (2.1.323's strings) send its requests to a provider other
 * than Anthropic's API: on only for "1", "true", "yes" or "on". Read only,
 * so a person's Bedrock or Vertex setup never carries Buzz's context. */
export const PROVIDERS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
] as const;
const ON = new Set(["1", "true", "yes", "on"]);
/** Claude's `account.apiProvider` for Anthropic's own API (2.1.325). */
const FIRST_PARTY = "firstParty";

/** One turn's attribution: the build's gateway origin, which Claude's own
 * endpoint must be on, and the shared contract's validated bundle. */
export type Attribution = Readonly<{
  origin: string;
  profile: GatewayProfile;
  headers: GatewayHeaders;
}>;

/** What a process's own settings say, read before Buzz changes any. */
export type Baseline = Readonly<{
  /** Its own custom headers, as Claude's newline-separated text. */
  headers: string | undefined;
  endpoint: string | undefined;
  /** It selects a provider other than Anthropic's API. */
  provider: boolean;
  /** Claude's inherited env sets custom headers, which its settings don't
   * report; undefined when that couldn't be checked. */
  inherited?: boolean | undefined;
}>;

const NOTICE = "Not attributed in the agent gateway";
export const UNREADABLE = `${NOTICE}: Claude didn't report its settings.`;
export const UNAPPLIED = `${NOTICE}: Claude didn't take Buzz's header change, so it may still send an earlier turn's Buzz headers.`;
export const PROVIDER = `${NOTICE}: Claude is set to use another provider.`;
export const ELSEWHERE = `${NOTICE}: Claude's own endpoint isn't the agent gateway.`;
export const INHERITED = `${NOTICE}: Claude's custom headers come from the app's environment, which Buzz can't read to keep them.`;
export const PROTECTED = `${NOTICE}: protected Claude agents keep their own pinned launch.`;
/** A shared-contract refusal (binding or context) as this turn's notice. */
export const refused = (message: string) => `${NOTICE}: ${message}`;

/** The effective env from Claude's `get_settings` answer; undefined when it
 * failed or isn't shaped as expected. */
export function readBaseline(answer: unknown): Baseline | undefined {
  const response = field(answer, "response");
  const effective = field(response, "effective");
  if (field(answer, "subtype") !== "success" || !record(effective)) return;
  const env = field(effective, "env");
  const text = (name: string) => {
    const value = field(env, name);
    return typeof value === "string" ? value : undefined;
  };
  return {
    headers: text("ANTHROPIC_CUSTOM_HEADERS"),
    endpoint: text("ANTHROPIC_BASE_URL"),
    provider: PROVIDERS.some((name) =>
      ON.has((text(name) ?? "").trim().toLowerCase()),
    ),
  };
}

/** Why `baseline` can't carry attribution for `origin`, as a notice. The
 * origin is compared (scheme, host and port), never the mode path, and
 * headers only Claude's inherited env sets are never replaced.
 * `provider` is what Claude's `initialize` resolved, which also sees a
 * selector in its process env; only Anthropic's API ("firstParty") or an
 * older Claude that reports none passes. */
export function ineligible(
  baseline: Baseline,
  origin: string,
  provider?: string,
) {
  if (baseline.provider || (provider !== undefined && provider !== FIRST_PARTY))
    return PROVIDER;
  if (originOf(baseline.endpoint) !== originOf(origin)) return ELSEWHERE;
  // A settings value outranks the inherited one, which then never reaches
  // the endpoint; without one, applying ours would replace it for good.
  if (baseline.headers === undefined && baseline.inherited !== false)
    return baseline.inherited ? INHERITED : UNREADABLE;
}

/** `baseline`'s lines without any header reserved to Buzz, whatever its case
 * or `_`/`-` spelling, then `bundle`'s: other headers pass through as the
 * person wrote them. */
export function customHeaders(
  profile: GatewayProfile,
  baseline: string | undefined,
  bundle: GatewayHeaders,
) {
  const kept = (baseline ?? "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() !== "" &&
        !isReservedHeader(profile, line.split(":", 1)[0]?.trim() ?? ""),
    );
  const added = Object.entries(bundle).map(
    ([name, value]) => `${name}: ${value}`,
  );
  return [...kept, ...added].join("\n");
}

const originOf = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, name: string) =>
  record(value) ? value[name] : undefined;
