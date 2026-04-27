import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = 4242;
const WEBHOOK_SECRET = process.env.FATHOM_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const COHERE_API_KEY = process.env.COHERE_API_KEY;
const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL || "http://localhost:8080/v1/chat/completions";
const DISCORD_WEBHOOK_URL = process.env.AETHER_DISCORD_WEBHOOK_URL;

let clientMap = {};
try {
  const mapPath = path.join(process.cwd(), "scripts", "client_map.json");
  clientMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
} catch (err) {
  console.error("[Fathom] Failed to load client_map.json:", err.message);
}

// ── Logging ──────────────────────────────────────────────────────────

function logJson(level, message, data = {}) {
  const log = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(log));
}

// ── Signature Verification ──────────────────────────────────────────

function verifySignature(req, body) {
  const webhookId = req.headers["webhook-id"];
  const webhookTimestamp = req.headers["webhook-timestamp"];
  const webhookSignature = req.headers["webhook-signature"];

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return false;
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;
  const hash = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(signedContent)
    .digest("base64");

  return hash === webhookSignature;
}

// ── Memory Storage (STUB) ────────────────────────────────────────────

async function saveMemoryWithEmbedding(memory) {
  logJson("info", "memory_received", { 
    type: memory.type, 
    client_id: memory.client_id, 
    content_length: memory.content.length 
  });
  return { id: "stub_" + Date.now() };
}

// ── Client ID Resolution ────────────────────────────────────────────

function resolveClientId(title) {
  const t = title.toLowerCase();
  for (const [keyword, clientId] of Object.entries(clientMap)) {
    if (t.includes(keyword.toLowerCase())) {
      return clientId;
    }
  }
  return null;
}

// ── Meeting Type Classification ─────────────────────────────────────

function classifyMeetingType(title) {
  const t = title.toLowerCase();
  if (t.includes("calibration sync")) return "client_calibration";
  if (t.includes("sales enablement sync")) return "internal_enablement";
  if (t.includes("cole") || t.includes("cro")) return "executive_cro";
  if (t.includes("lance") || t.includes("ceo")) return "executive_ceo";
  return "general";
}

// ── Transcript Chunking ─────────────────────────────────────────────

function chunkTranscript(plainText, wordsPerChunk = 800) {
  const words = plainText.split(/\s+/);
  const chunks = [];

  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(" "));
  }

  return chunks;
}

// ── Webhook Handler ─────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "POST" && req.url === "/fathom/webhook") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      try {
        logJson("info", "webhook_request_received", { body_length: body.length });

        if (WEBHOOK_SECRET && !verifySignature(req, body)) {
          logJson("warn", "fathom_webhook_invalid_signature");
          res.writeHead(401);
          return res.end(JSON.stringify({ error: "Signature verification failed" }));
        }

        const payload = JSON.parse(body);
        const { title, transcript } = payload;

        if (!transcript || transcript.length === 0) {
          logJson("warn", "fathom_webhook_no_transcript");
          res.writeHead(200);
          return res.end(JSON.stringify({ status: "ok" }));
        }

        const clientId = resolveClientId(title);
        const meetingType = classifyMeetingType(title);

        const plainText = transcript
          .map((t) => `${t.speaker}: ${t.text}`)
          .join("\n");

        const chunks = chunkTranscript(plainText);

        logJson("info", "fathom_webhook_received", {
          call_title: title,
          client_id: clientId,
          meeting_type: meetingType,
          chunk_count: chunks.length,
        });

        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", chunks_queued: chunks.length }));

        // Process asynchronously
        setImmediate(async () => {
          try {
            for (const chunk of chunks) {
              await saveMemoryWithEmbedding({
                type: "meeting_transcript",
                content: chunk,
                client_id: clientId,
              });
            }
            logJson("info", "fathom_transcript_processed", {
              call_title: title,
              chunks_saved: chunks.length,
            });
          } catch (err) {
            logJson("error", "fathom_processing_failed", {
              error: err.message,
            });
          }
        });
      } catch (err) {
        logJson("error", "fathom_webhook_error", { error: err.message });
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Webhook error" }));
      }
    });
  } else if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  logJson("info", "fathom_webhook_server_started", { port: PORT });
});

process.on("SIGTERM", () => {
  logJson("info", "fathom_webhook_shutdown_signal");
  server.close(() => {
    process.exit(0);
  });
});
