// Serves the test page and a mock OpenAI-compatible translation endpoint, so
// tests run offline and get deterministic translations.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PORT } from "./constants.mjs";

const PAGES = {
  "/hostile.html": new URL("./pages/hostile.html", import.meta.url)
};

// A text containing this marker is answered slowly, for stale-response tests
const SLOW_MARKER = "[slow]";
const SLOW_DELAY_MS = 1500;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Reply "<model>:<target language>:<text>" so tests can assert which
// provider and language were used
async function handleCompletion(req, res) {
  const { model, messages } = JSON.parse(await readBody(req));
  const systemPrompt = messages.find((m) => m.role === "system")?.content || "";
  const text = messages.find((m) => m.role === "user")?.content || "";
  const target = systemPrompt.match(/ to ([\w-]+)\./)?.[1] || "unknown";

  if (text.includes(SLOW_MARKER)) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_DELAY_MS));
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: `${model}:${target}:${text}` } }]
    })
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      await handleCompletion(req, res);
      return;
    }

    if (req.method === "GET" && PAGES[pathname]) {
      const html = await readFile(fileURLToPath(PAGES[pathname]));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`TransKit e2e server on http://127.0.0.1:${PORT}`);
});
