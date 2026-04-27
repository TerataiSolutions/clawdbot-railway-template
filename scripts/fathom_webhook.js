import express from "express";
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

function logJson(level, message, data = {}) {
  const log = { timestamp: new Date().toISOString(), level, message, ...data };
  console.log(JSON.stringify(log));
}

function verifySignature(req, body) {
  const webhookId = req.headers["webhook-id"];
  const webhookTimestamp = req.headers["webhook-timestamp"];
  const webhookSignature = req.headers["webhook-signature"];
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;
  const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;
  const hash = crypto.createHmac("sha256", WEBHOOK_SECRET).update(signedContent).digest("base64");
  return hash === webhookSignature;
}

async function saveMemoryWithEmbedding(memory) {
  logJson("info", "memory_received", {
    type: memory.type,
    client_id: memory.client_id,
    content_length: memory.content.length
  });
  return { id: "stub_" + Date.now() };
}

function resolveClientId(title) {
  const t = title.toLowerCase();
  for (const [keyword, clientId] of Object.entries(clientMap)) {
    if (t.includes(keyword.toLowerCase())) return clientId;
  }
  return null;
}

function classifyMeetingType(title) {
  const t = title.toLowerCase();
  if (t.includes("calibration sync")) return "client_calibration";
  if (t.includes("sales enablement sync")) return "internal_enablement";
  if (t.includes("cole") || t.includes("cro")) return "executive_cro";
  if (t.includes("lance") || t.includes("ceo")) return "executive_ceo";
  return "general";
}

function chunkTranscript(plainText, wordsPerChunk = 800) {
  const words = plainText.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(" "));
  }
  return chunks;
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));

app.post("/fathom/webhook", async (req, res) => {
  try {
    logJson("info", "webhook_request_received", {
      body_length: JSON.stringify(req.body).length,
      content_type: req.headers["content-type"]
    });

    const bodyString = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    if (WEBHOOK_SECRET && !verifySignature(req, bodyString)) {
      logJson("warn", "fathom_webhook_invalid_signature");
      return res.status(401).json({ error: "Signature verification failed" });
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { title, transcript } = payload;

    if (!transcript || transcript.length === 0) {
      logJson("warn", "fathom_webhook_no_transcript");
      return res.status(200).json({ status: "ok" });
    }

    const clientId = resolveClientId(title);
    const meetingType = classifyMeetingType(title);
    const plainText = transcript.map((t) => `${t.speaker}: ${t.text}`).join("\n");
    const chunks = chunkTranscript(plainText);

    logJson("info", "fathom_webhook_received", {
      call_title: title,
      client_id: clientId,
      meeting_type: meetingType,
      chunk_count: chunks.length,
    });

    res.status(200).json({ status: "ok", chunks_queued: chunks.length });

    setImmediate(async () => {
      try {
        for (const chunk of chunks) {
          await saveMemoryWithEmbedding({ type: "meeting_transcript", content: chunk, client_id: clientId });
        }
        logJson("info", "fathom_transcript_processed", { call_title: title, chunks_saved: chunks.length });
      } catch (err) {
        logJson("error", "fathom_processing_failed", { error: err.message });
      }
    });
  } catch (err) {
    logJson("error", "fathom_webhook_error", { error: err.message });
    res.status(500).json({ error: "Webhook error" });
  }
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const server = app.listen(PORT, "127.0.0.1", () => {
  logJson("info", "fathom_webhook_server_started", { port: PORT });
});

process.on("SIGTERM", () => {
  logJson("info", "fathom_webhook_shutdown_signal");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  logJson("info", "fathom_webhook_interrupt_signal");
  server.close(() => process.exit(0));
});

server.on("error", (err) => {
  logJson("error", "fathom_webhook_server_error", { error: err.message });
  process.exit(1);
});
