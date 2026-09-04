import { expect, test } from "bun:test";

const appRoot = new URL("..", import.meta.url).pathname;

test("forwards Read v5 options and preserves 400 responses", async () => {
  const requests: URL[] = [];
  const upstream = Bun.serve({
    port: 18306,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url);
      const body = await request.json() as { text: string };
      if (body.text === "invalid") {
        return Response.json({ err_code: "BAD_REQUEST", err_msg: "invalid text" }, { status: 400 });
      }
      return Response.json({ results: { summary: { result: "summary" } } });
    },
  });
  const app = Bun.spawn(["bun", "server.ts"], {
    cwd: appRoot,
    env: { ...process.env, DEEPGRAM_API_KEY: "test-key", DEEPGRAM_BASE_URL: "http://127.0.0.1:18306", PORT: "18305" },
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await fetch("http://127.0.0.1:18305/health")).ok) break; } catch {}
      await Bun.sleep(50);
    }
    const { token } = await (await fetch("http://127.0.0.1:18305/api/session")).json() as { token: string };
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const success = await fetch("http://127.0.0.1:18305/api/text-intelligence?summarize=v2&topics=true", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "valid" }),
    });
    expect(success.status).toBe(200);
    expect((await success.json() as { results: { summary: { result: string } } }).results.summary.result).toBe("summary");
    expect(requests[0].pathname).toBe("/v1/read");
    expect(requests[0].searchParams.get("summarize")).toBe("v2");
    expect(requests[0].searchParams.get("topics")).toBe("true");

    const invalid = await fetch("http://127.0.0.1:18305/api/text-intelligence", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "invalid" }),
    });
    expect(invalid.status).toBe(400);
  } finally {
    app.kill();
    await app.exited;
    upstream.stop();
  }
});
