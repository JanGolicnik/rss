import http from "node:http";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const [key, ...rest] = trimmed.split("=");
  process.env[key.trim()] ??= rest.join("=").trim();
}

const SECRET = process.env.WEBHOOK_SECRET ?? "";
const SERVICE = process.env.WEBHOOK_SERVICE_NAME ?? "blogson";
const BRANCH = process.env.WEBHOOK_BRANCH ?? "master";

function verify(body, header) {
  if (!header?.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

function run(cmd) {
  try {
    return {
      code: 0,
      out: execSync(cmd, { timeout: 60000 }).toString().trim(),
    };
  } catch (e) {
    return {
      code: e.status ?? -1,
      out: e.stderr?.toString().trim() ?? e.message,
    };
  }
}

http
  .createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/_hook") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const sig = req.headers["x-hub-signature-256"] ?? "";

      if (!SECRET) {
        res.writeHead(500);
        res.end("Webhook secret not configured");
        return;
      }
      if (!verify(body, sig)) {
        res.writeHead(401);
        res.end("Invalid signature");
        return;
      }

      const event = req.headers["x-github-event"] ?? "";
      if (event === "ping") {
        res.writeHead(200);
        res.end("pong\n");
        return;
      }
      if (event !== "push") {
        res.writeHead(200);
        res.end(`Ignoring event: ${event}\n`);
        return;
      }

      const payload = JSON.parse(body.toString() || "{}");
      if (payload.ref !== `refs/heads/${BRANCH}`) {
        res.writeHead(200);
        res.end(`Ignoring push to ${payload.ref}\n`);
        return;
      }

      const log = [];
      const pull = run("git pull");
      log.push(`[pull] exit=${pull.code}\n${pull.out}`);

      if (pull.code !== 0) {
        const report = log.join("\n");
        console.log(report);
        res.writeHead(500);
        res.end(report + "\n");
        return;
      }

      const restart = run(`sudo systemctl restart ${SERVICE}`);
      log.push(`[restart] exit=${restart.code}\n${restart.out}`);

      const report = log.join("\n");
      console.log(report);
      res.writeHead(restart.code === 0 ? 200 : 500);
      res.end(report + "\n");

      setTimeout(() => run("sudo systemctl restart blogson-deploy"), 1000);
    });
  })
  .listen(5002, "127.0.0.1");
