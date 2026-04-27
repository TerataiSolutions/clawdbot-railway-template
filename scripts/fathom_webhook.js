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
const FETCH_TIMEOUT_MS = 30000; // 30 second timeout for external API calls

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

// ── Timeout Wrapper ──────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Fetch timeout after ${timeoutMs}ms to ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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

// ── Embedding Generation ────────────────────────────────────────────

async function generateEmbedding(text, inputType = "search_document") {
  if (!COHERE_API_KEY) {
    throw new Error("COHERE_API_KEY not set");
  }

  logJson("info", "generateEmbedding_start", { text_length: text.length, input_type: inputType });

  const response = await fetchWithTimeout("https://api.cohere.ai/v1/embed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      texts: [text],
      model: "embed-english-v3.0",
      input_type: inputType,
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => response.statusText);
    throw new Error(`Cohere API error: ${response.status} ${response.statusText} - ${error}`);
  }

  const data = await response.json();
  logJson("info", "generateEmbedding_success");
  return data.embeddings[0];
}

// ── Memory Storage ──────────────────────────────────────────────────

async function saveMemoryWithEmbedding(memory) {
  if (!memory.type || !memory.content) {
    throw new Error("Memory must have type and content");
  }

  if (memory.type.startsWith("client_") && !memory.client_id) {
    throw new Error(`Memory type ${memory.type} requires client_id`);
  }

  logJson("info", "saveMemory_start", { type: memory.type, client_id: memory.client_id });

  let embedding;
  try {
    embedding = await generateEmbedding(memory.content, "search_document");
  } catch (err) {
    logJson("error", "Embedding generation failed", {
      error: err.message,
      content_length: memory.content.length,
    });
    throw err;
  }

  const payload = {
    type: memory.type,
    content: memory.content,
    client_id: memory.client_id || null,
    importance: memory.importance || 5,
    tags: memory.tags || [],
    embedding,
  };

  logJson("info", "saveMemory_inserting_to_supabase", { url: SUPABASE_URL });

  const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/memories`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase insert failed: ${response.statusText} - ${error}`);
  }

  const saved = await response.json();
  logJson("info", "saveMemory_success", { memory_id: saved[0]?.id });
  return saved[0];
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

// ── Post-Ingest Analysis ────────────────────────────────────────────

async function runPostIngestAnalysis({ clientId, plainText, meetingTitle, meetingType }) {
  const analyses = await Promise.allSettled([
    captureCompetitiveIntel(clientId, plainText),
    detectIcpDrift(clientId, plainText),
    summarizeExecutiveSync(plainText, meetingType),
    extractStrategyInputs(clientId, plainText, meetingType),
  ]);

  analyses.forEach((result, index) => {
    if (result.status === "rejected") {
      const analysisNames = [
        "competitive_intel",
        "icp_drift",
        "executive_summary",
        "strategy_inputs",
      ];
      logJson("warn", `Post-ingest analysis failed: ${analysisNames[index]}`, {
        error: result.reason?.message || String(result.reason),
      });
    }
  });
}

async function captureCompetitiveIntel(clientId, plainText) {
  const competitors = ["salesforce", "microsoft", "google", "hubspot", "zendesk"];
  const found = competitors.filter((c) =>
    plainText.toLowerCase().includes(c)
  );

  if (found.length > 0) {
    await saveMemoryWithEmbedding({
      type: "competitive_intel",
      content: `Competitors mentioned: ${found.join(", ")}`,
      client_id: clientId,
      importance: 7,
      tags: ["competitive_intel", `client_${clientId}`, "fathom_auto"],
    });
  }
}

async function detectIcpDrift(clientId, plainText) {
  const driftSignals = [
    "we're not the right fit",
    "too expensive",
    "no budget",
    "wrong use case",
  ];
  const found = driftSignals.filter((signal) =>
    plainText.toLowerCase().includes(signal)
  );

  if (found.length > 0) {
    await saveMemoryWithEmbedding({
      type: "icp_misalignment",
      content: `ICP drift signals detected: ${found.join(", ")}`,
      client_id: clientId,
      importance: 8,
      tags: ["icp_misalignment", `client_${clientId}`, "fathom_auto"],
    });

    if (DISCORD_WEBHOOK_URL) {
      await fetchWithTimeout(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `⚠️ ICP drift detected for ${clientId}: ${found.join(", ")}`,
        }),
      }).catch((err) =>
        logJson("warn", "Discord alert failed", { error: err.message })
      );
    }
  }
}

async function summarizeExecutiveSync(plainText, meetingType) {
  if (!["executive_cro", "executive_ceo"].includes(meetingType)) {
    return;
  }

  const response = await fetchWithTimeout(OPENCLAW_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "user",
          content: `Summarize this executive meeting. Extract DECISIONS, DIRECTIVES, and ACTION ITEMS:\n\n${plainText}`,
        },
      ],
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    throw new Error(`Gateway error: ${response.statusText}`);
  }

  const data = await response.json();
  const summary = data.choices[0].message.content;

  await saveMemoryWithEmbedding({
    type: "decision",
    content: summary,
    importance: 9,
    tags: ["decision", "executive_sync", "fathom_auto"],
  });
}

async function extractStrategyInputs(clientId, plainText, meetingType) {
  if (meetingType !== "client_calibration") {
    return;
  }

  const response = await fetchWithTimeout(OPENCLAW_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "user",
          content: `Extract strategic insights from this client calibration meeting for ${clientId}:\n\n${plainText}`,
        },
      ],
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    throw new Error(`Gateway error: ${response.statusText}`);
  }

  const data = await response.json();
  const insights = data.choices[0].message.content;

  await saveMemoryWithEmbedding({
    type: "strategy_input",
    content: insights,
    client_id: clientId,
    importance: 8,
    tags: ["strategy_input", `client_${clientId}`, "fathom_auto"],
  });
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
        const { title, transcript, summary, action_items } = payload;

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

        // Process asynchronously after responding
        try {
          for (const chunk of chunks) {
            await saveMemoryWithEmbedding({
              type: "meeting_transcript",
              content: chunk,
              client_id: clientId,
              importance: 8,
              tags: [
                "meeting_transcript",
                `client_${clientId}`,
                "fathom_auto",
              ],
            });
          }

          logJson("info", "fathom_transcript_ingested", {
            call_title: title,
            client_id: clientId,
            chunks_saved: chunks.length,
          });

          if (clientId) {
            await runPostIngestAnalysis({
              clientId,
              plainText,
              meetingTitle: title,
              meetingType,
            });
          }
        } catch (err) {
          logJson("error", "fathom_ingest_failed", {
            call_title: title,
            error: err.message,
          });
        }
      } catch (err) {
        logJson("error", "fathom_webhook_error", {
          error: err.message,
          stack: err.stack,
        });
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Processing failed" }));
      }
    });
  } else if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok" }));
  } else if (req.method === "POST" && req.url === "/assign") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const { token, client_id } = JSON.parse(body);
        logJson("info", "fathom_manual_assign", { token, client_id });
        res.writeHead(200);
        res.end(JSON.stringify({ status: "assigned" }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });
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
