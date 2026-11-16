import { describe, expect, it, vi } from "vitest";
import { inferenceBundle } from "../../features/agents/gateway/contract";
import {
  VECTOR_BINDING,
  VECTOR_PROFILE,
} from "../../features/agents/gateway/vectors";
import {
  customHeaders,
  ELSEWHERE,
  INHERITED,
  ineligible,
  PROVIDER,
  PROVIDERS,
  readBaseline,
  UNAPPLIED,
  UNREADABLE,
} from "./attribution";
import { ClaudeProcess } from "./claude";
import { fakeSpawn } from "./claude-testing";

const GATEWAY = "https://gateway.example";
const bundle = (message: string | null) => {
  const built = inferenceBundle(VECTOR_PROFILE, VECTOR_BINDING, {
    channel_id: "33333333-3333-4333-8333-333333333333",
    message_id: message,
    thread_id: null,
  });
  if (!built.ok) throw new Error(built.message);
  return built.value;
};
const attribution = (message: string | null) => ({
  origin: GATEWAY,
  profile: VECTOR_PROFILE,
  headers: bundle(message),
});
const settings = (env: Record<string, unknown>) => ({
  subtype: "success",
  response: { effective: { env } },
});

describe("readBaseline", () => {
  it("reads only the custom headers, endpoint and provider selectors", () => {
    expect(
      readBaseline(
        settings({
          ANTHROPIC_BASE_URL: `${GATEWAY}/pass-through/anthropic`,
          ANTHROPIC_CUSTOM_HEADERS: "x-keep: 1",
          ANTHROPIC_AUTH_TOKEN: "secret",
        }),
      ),
    ).toEqual({
      headers: "x-keep: 1",
      endpoint: `${GATEWAY}/pass-through/anthropic`,
      provider: false,
    });
  });

  it("is empty without env, and unread for a failed or malformed answer", () => {
    expect(
      readBaseline({ subtype: "success", response: { effective: {} } }),
    ).toEqual({ headers: undefined, endpoint: undefined, provider: false });
    expect(readBaseline({ subtype: "error" })).toBeUndefined();
    expect(readBaseline({ subtype: "success", response: {} })).toBeUndefined();
  });

  it("counts a provider selector only when it is on", () => {
    for (const name of PROVIDERS) {
      expect(readBaseline(settings({ [name]: " TRUE " }))?.provider).toBe(true);
      expect(readBaseline(settings({ [name]: "0" }))?.provider).toBe(false);
    }
  });
});

describe("ineligible", () => {
  const baseline = (endpoint?: string, provider = false) => ({
    headers: undefined,
    endpoint,
    provider,
    inherited: false,
  });

  it("accepts the gateway's origin on either mode path", () => {
    for (const path of ["/pass-through/anthropic", "/ai-gateway/anthropic"])
      expect(
        ineligible(baseline(`${GATEWAY}${path}`), GATEWAY),
      ).toBeUndefined();
    expect(
      ineligible(baseline("https://gateway.example:443/x"), GATEWAY),
    ).toBeUndefined();
  });

  it("refuses another origin, a missing or unparsable endpoint, or a provider", () => {
    for (const endpoint of [
      "https://gateway.example:8443/pass-through/anthropic",
      "http://gateway.example/pass-through/anthropic",
      "https://other.example/pass-through/anthropic",
      "not a url",
      undefined,
    ])
      expect(ineligible(baseline(endpoint), GATEWAY)).toBe(ELSEWHERE);
    expect(ineligible(baseline(`${GATEWAY}/a`, true), GATEWAY)).toBe(PROVIDER);
  });

  it("never replaces headers only the inherited env sets", () => {
    const endpoint = `${GATEWAY}/a`;
    const own = { ...baseline(endpoint), inherited: true };
    expect(ineligible(own, GATEWAY)).toBe(INHERITED);
    expect(ineligible({ ...own, inherited: undefined }, GATEWAY)).toBe(
      UNREADABLE,
    );
    // A settings value outranks the inherited one, so it is the baseline.
    expect(ineligible({ ...own, headers: "x-keep: 1" }, GATEWAY)).toBe(
      undefined,
    );
  });
});

describe("customHeaders", () => {
  it("keeps the person's headers and replaces any Buzz-reserved one", () => {
    const composed = customHeaders(
      VECTOR_PROFILE,
      "x-keep: configured\r\nX_GW_CTX_MESSAGE_ID: stale\nX-Gw-Launcher-Session: old\n\nx-other: a:b",
      bundle("c".repeat(64)),
    );
    const lines = composed.split("\n");
    expect(lines.slice(0, 2)).toEqual(["x-keep: configured", "x-other: a:b"]);
    expect(lines).toContain(`x-gw-ctx-message-id: ${"c".repeat(64)}`);
    expect(composed).not.toMatch(/stale|old/);
  });

  it("omits a null role", () => {
    expect(customHeaders(VECTOR_PROFILE, undefined, bundle(null))).not.toMatch(
      /message-id|thread-id/,
    );
  });
});

describe("ClaudeProcess.attribute", () => {
  const launch = { cwd: "~/.buzz", systemPrompt: "", sessionId: "s1" };
  const subtypes = (received: Record<string, unknown>[]) =>
    received
      .map((message) => (message.request as { subtype?: string })?.subtype)
      .filter(Boolean);

  async function started(
    env: Record<string, string>,
    check: Parameters<typeof fakeSpawn>[2] = {},
  ) {
    const { spawn, processes } = fakeSpawn(undefined, env, check);
    const claude = await ClaudeProcess.start(spawn, launch);
    const fake = processes[0];
    if (!fake) throw new Error("no process");
    return { claude, fake };
  }
  const ON_GATEWAY = {
    ANTHROPIC_BASE_URL: `${GATEWAY}/ai-gateway/anthropic`,
    ANTHROPIC_CUSTOM_HEADERS: "x-keep: configured",
  };

  it("updates, keeps for a steer, and removes Buzz's headers in one process", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    await expect(claude.attribute(attribution("1".repeat(64)))).resolves.toBe(
      undefined,
    );
    await claude.send("first", { effort: "low" });
    fake.hold = true;
    await claude.attribute(attribution("2".repeat(64)));
    const second = claude.send("second", { effort: "low" });
    // A steer is sent without asking for attribution: it keeps the turn's.
    const steer = claude.send("steer");
    fake.finish();
    await Promise.all([second, steer]);
    fake.hold = false;
    await claude.attribute(undefined);
    await claude.send("third");
    const [first, two, steered, third] = fake.headers;
    expect(first).toContain(`x-gw-ctx-message-id: ${"1".repeat(64)}`);
    expect(two).toContain(`x-gw-ctx-message-id: ${"2".repeat(64)}`);
    expect(steered).toBe(two);
    expect(third).toBe("x-keep: configured");
    for (const headers of fake.headers)
      expect(headers).toMatch(/^x-keep: configured/);
    // The baseline is read once, before the first change; the endpoint and
    // effort are left alone.
    expect(subtypes(fake.received).filter((s) => s === "get_settings")).toEqual(
      ["get_settings", "get_settings"],
    );
    expect(fake.env.ANTHROPIC_BASE_URL).toBe(ON_GATEWAY.ANTHROPIC_BASE_URL);
    expect(fake.efforts).toEqual(["low", "low", "low", "high"]);
  });

  it("does nothing for a process Buzz never attributed", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    await expect(claude.attribute(undefined)).resolves.toBeUndefined();
    expect(subtypes(fake.received)).toEqual(["initialize"]);
  });

  it("leaves another endpoint or provider unattributed, with a notice", async () => {
    const elsewhere = await started({ ANTHROPIC_BASE_URL: "https://api.x" });
    await expect(elsewhere.claude.attribute(attribution(null))).resolves.toBe(
      ELSEWHERE,
    );
    const provider = await started({
      ...ON_GATEWAY,
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    await expect(provider.claude.attribute(attribution(null))).resolves.toBe(
      PROVIDER,
    );
    // A selector in Claude's process env shows only in what it resolved.
    const resolved = await started(ON_GATEWAY, { apiProvider: "bedrock" });
    await expect(resolved.claude.attribute(attribution(null))).resolves.toBe(
      PROVIDER,
    );
    for (const { fake } of [elsewhere, provider, resolved])
      expect(subtypes(fake.received)).not.toContain("apply_flag_settings");
  });

  it("leaves inherited-only headers alone, and keeps a settings value over them", async () => {
    const { ANTHROPIC_BASE_URL } = ON_GATEWAY;
    const only = await started({ ANTHROPIC_BASE_URL }, { inherited: "set" });
    await expect(only.claude.attribute(attribution(null))).resolves.toBe(
      INHERITED,
    );
    await expect(only.claude.send("still runs")).resolves.toMatchObject({
      ok: true,
    });
    await expect(only.claude.attribute(undefined)).resolves.toBeUndefined();
    expect(subtypes(only.fake.received)).not.toContain("apply_flag_settings");
    const unchecked = await started(
      { ANTHROPIC_BASE_URL },
      { inherited: "fail" },
    );
    await expect(unchecked.claude.attribute(attribution(null))).resolves.toBe(
      UNREADABLE,
    );
    // Settings headers win over inherited ones: updated, then restored.
    const both = await started(ON_GATEWAY, { inherited: "set" });
    await both.claude.attribute(attribution("1".repeat(64)));
    await both.claude.send("first");
    await both.claude.attribute(attribution("2".repeat(64)));
    await both.claude.send("second");
    await both.claude.attribute(undefined);
    await both.claude.send("third");
    const [first, second, third] = both.fake.headers;
    expect(first).toContain(`x-gw-ctx-message-id: ${"1".repeat(64)}`);
    expect(second).toContain(`x-gw-ctx-message-id: ${"2".repeat(64)}`);
    expect(third).toBe("x-keep: configured");
  });

  it("goes on unattributed when Claude doesn't answer, and restores after", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    await claude.attribute(attribution("1".repeat(64)));
    fake.ignoreEnv = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = claude.attribute(attribution("2".repeat(64)));
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toBe(UNAPPLIED);
    } finally {
      vi.useRealTimers();
    }
    fake.ignoreEnv = false;
    // Whatever Claude took, the restore is still sent.
    await claude.attribute(undefined);
    await claude.send("restored");
    expect(fake.headers).toEqual(["x-keep: configured"]);
  });

  it("reports a refused update without failing the turn", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    fake.refuseEnv = true;
    await expect(claude.attribute(attribution(null))).resolves.toMatch(
      /didn't take Buzz's header change/,
    );
    await expect(claude.send("still runs")).resolves.toMatchObject({
      ok: true,
    });
    expect(fake.headers).toEqual(["x-keep: configured"]);
  });
});
