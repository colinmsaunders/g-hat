import { createServer } from "node:http";
import { createApp } from "./app";
import { MemoryStore } from "./memory";
const app = createApp(new MemoryStore());
createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (req.url === "/config.json") {
    res.end(JSON.stringify({ apiUrl: "/api", local: true }));
    return;
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16000) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: "Request too large." }));
      return;
    }
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const result = await app({
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    body,
    token: req.headers.authorization?.replace(/^Bearer /i, ""),
    ip: req.socket.remoteAddress ?? "local",
  });
  res.writeHead(result.status);
  res.end(JSON.stringify(result.body));
}).listen(3001, "127.0.0.1", () =>
  console.log(
    "Local API http://127.0.0.1:3001 — in-memory data, no AWS credentials needed",
  ),
);
