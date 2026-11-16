// @vitest-environment node
// Drives a real `claude` against a loopback Anthropic stand-in, with a fake
// key and an isolated config folder: run with CLAUDE_LIVE_BIN=/path/to/claude.
// It proves what reaches the endpoint, not real sign-in or gateway delivery.
import { spawn as spawnChild } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inferenceBundle } from "../../features/agents/gateway/contract";
import {
  VECTOR_BINDING,
  VECTOR_PROFILE,
} from "../../features/agents/gateway/vectors";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeProcess, type Spawn } from "./claude";

const BIN = process.env.CLAUDE_LIVE_BIN;
const MODEL = "claude-sonnet-4-6";
const { headers: roles } = VECTOR_PROFILE;
/** Each model request's headers, in order. */
const requests: IncomingHttpHeaders[] = [];
const server = createServer(async (request, response) => {
  for await (const _ of request);
  if (!request.url?.startsWith("/v1/messages")) return void response.end("{}");
  if (request.url.includes("count_tokens"))
    return void response.end('{"input_tokens":1}');
  requests.push(request.headers);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const message = {
    id: "msg",
    type: "message",
    role: "assistant",
    model: MODEL,
  };
  for (const [type, payload] of [
    [
      "message_start",
      {
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { index: 0, delta: { type: "text_delta", text: "ok" } },
    ],
    ["content_block_stop", { index: 0 }],
    [
      "message_delta",
      { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ],
    ["message_stop", {}],
  ] as const)
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`,
    );
  response.end();
});
let origin = "";
const folders: string[] = [];

/** A spawn of the real binary in an isolated config folder whose settings
 * point it at the stand-in, as a person's gateway setup does. */
function isolated(settings: Record<string, string>): Spawn {
  const home = mkdtempSync(join(tmpdir(), "buzz-attribution-"));
  folders.push(home);
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: origin, ...settings } }),
  );
  return async (_id, options: HostProcessOptions = {}) => {
    const env: Record<string, string | undefined> = { PATH: process.env.PATH };
    for (const [key, value] of Object.entries(options.env ?? {}))
      if (value !== null) env[key] = value;
    Object.assign(env, {
      HOME: home,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: "fake-fixture-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    });
    const child = spawnChild(BIN ?? "claude", options.args ?? [], {
      cwd: home,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      options.onStdout?.(data);
    });
    child.stderr.setEncoding("utf8").on("data", options.onStderr ?? (() => {}));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    return {
      write: (data) =>
        new Promise<void>((resolve, reject) =>
          child.stdin.write(data, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      end: async (data) => void child.stdin.end(data),
      kill: async () => void child.kill(),
      exited,
    };
  };
}
const attribution = (message: string) => {
  const bundle = inferenceBundle(VECTOR_PROFILE, VECTOR_BINDING, {
    channel_id: null,
    message_id: message,
    thread_id: null,
  });
  if (!bundle.ok) throw new Error(bundle.message);
  return { origin, profile: VECTOR_PROFILE, headers: bundle.value };
};
/** The requests a turn sent, after `from`. */
async function turn(claude: ClaudeProcess, text: string) {
  const from = requests.length;
  await expect(claude.send(text)).resolves.toMatchObject({ ok: true });
  return requests.slice(from);
}

describe.skipIf(!BIN)("claude attribution", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
    for (const folder of folders)
      rmSync(folder, { recursive: true, force: true });
  });

  it("updates and removes Buzz's headers in one process, keeping the person's", {
    timeout: 120_000,
  }, async () => {
    const claude = await ClaudeProcess.start(
      isolated({
        ANTHROPIC_CUSTOM_HEADERS: `x-keep-live: configured\n${roles.message_id}: user-config`,
      }),
      { cwd: "/", systemPrompt: "Answer in one word.", model: MODEL },
    );
    try {
      const m1 = "1".repeat(64);
      const m2 = "2".repeat(64);
      await expect(claude.attribute(attribution(m1))).resolves.toBeUndefined();
      const first = await turn(claude, "Reply with one word.");
      await expect(claude.attribute(attribution(m2))).resolves.toBeUndefined();
      const second = await turn(claude, "Reply again.");
      await expect(claude.attribute(undefined)).resolves.toBeUndefined();
      const third = await turn(claude, "Reply once more.");
      for (const requests of [first, second, third]) {
        expect(requests.length).toBeGreaterThan(0);
        for (const headers of requests)
          expect(headers["x-keep-live"]).toBe("configured");
      }
      expect(first.map((headers) => headers[roles.message_id])).toContain(m1);
      expect(first.every((headers) => headers[roles.launcher_session])).toBe(
        true,
      );
      expect(second.map((headers) => headers[roles.message_id])).toContain(m2);
      // Restored: the person's own value again, and no Buzz session.
      for (const headers of third) {
        expect(headers[roles.message_id]).toBe("user-config");
        expect(headers[roles.launcher_session]).toBeUndefined();
      }
    } finally {
      await claude.kill();
    }
  });

  it("removes Buzz's headers where the person set none", {
    timeout: 120_000,
  }, async () => {
    const claude = await ClaudeProcess.start(isolated({}), {
      cwd: "/",
      systemPrompt: "Answer in one word.",
      model: MODEL,
    });
    try {
      await claude.attribute(attribution("3".repeat(64)));
      const attributed = await turn(claude, "Reply with one word.");
      expect(attributed.some((headers) => headers[roles.launcher_client])).toBe(
        true,
      );
      await claude.attribute(undefined);
      const restored = await turn(claude, "Reply again.");
      expect(restored.length).toBeGreaterThan(0);
      for (const headers of restored)
        expect(
          Object.keys(headers).filter((name) => name.startsWith("x-gw-")),
        ).toEqual([]);
    } finally {
      await claude.kill();
    }
  });
});
