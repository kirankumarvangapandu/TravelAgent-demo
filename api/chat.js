// Vercel serverless function (Node.js runtime).
// Mirrors agent-demo2.py: same system prompt, same model default, same
// tool-use loop, same search_travel_policies tool — just reachable over
// HTTP instead of a terminal.
const Anthropic = require("@anthropic-ai/sdk");
const { get: getBlob } = require("@vercel/blob");

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 2000;
const MAX_TOOL_ROUNDS = 3;
const VOYAGE_MODEL = "voyage-3.5";

const SYSTEM_PROMPT = `You are an expert, friendly travel agent helping someone plan a vacation.

Given the traveler's details, respond with:
1. Three well-suited destination options, each with a short paragraph explaining
   why it fits their budget, interests, timing, and constraints.
2. For your top recommendation, a rough day-by-day highlight itinerary.
3. Flight guidance: typical airlines/routes and connection patterns from their
   departure city, typical flight duration, and a rough indicative price range
   based on general knowledge. You do NOT have access to live booking data, so
   never invent specific flight numbers, exact prices, or real-time seat
   availability — clearly note these are general estimates and recommend the
   traveler check a flight search site (e.g. Google Flights, Skyscanner) for
   live prices and booking.
4. A few practical tips relevant to the trip (packing, visas, best time to
   book, local customs, etc.) where relevant.

You also have a search_travel_policies tool that searches Voyagent's own
cancellation, baggage, and travel insurance policy documents. Call it when the
traveler asks about cancellations, refunds, baggage allowances/fees, lost or
delayed luggage, or travel insurance coverage/claims. Do not call it for
general destination, itinerary, or flight-guidance questions. When you use it,
base your answer on the returned policy text and make clear it reflects
Voyagent's policy.

Keep the tone helpful and concise. Format the response with clear headings and
bullet points so it reads well in a compact chat widget (no tables).`;

const TOOLS = [
  {
    name: "search_travel_policies",
    description:
      "Search Voyagent's cancellation, baggage, and travel insurance policy knowledge base. Call this when the traveler asks about cancellations, refunds, baggage allowances/fees, lost or delayed luggage, or travel insurance coverage/claims. Do not call it for general destination, itinerary, or flight-guidance questions.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused search query describing what policy information is needed.",
        },
      },
      required: ["query"],
    },
  },
];

let kbCache = null; // { url, chunks: [{heading, text}], embeddings: number[][] }

function isValidMessage(m) {
  return (
    m &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string" &&
    m.content.trim().length > 0
  );
}

function chunkMarkdown(markdown) {
  const lines = markdown.split("\n");
  const chunks = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^##\s+(.*)/);
    if (match) {
      if (current) chunks.push(current);
      current = { heading: match[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) chunks.push(current);
  return chunks
    .map((c) => ({ heading: c.heading, text: c.lines.join("\n").trim() }))
    .filter((c) => c.text.length > 0);
}

async function embedTexts(texts, inputType) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings request failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function ensureKnowledgeBaseEmbeddings() {
  const url = process.env.KNOWLEDGE_BASE_URL;
  if (kbCache && kbCache.url === url) return kbCache;
  const result = await getBlob(url, {
    access: "private",
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  if (!result || !result.stream) throw new Error("Knowledge base blob not found");
  const markdown = await new Response(result.stream).text();
  const chunks = chunkMarkdown(markdown);
  const embeddings = await embedTexts(
    chunks.map((c) => c.text),
    "document"
  );
  kbCache = { url, chunks, embeddings };
  return kbCache;
}

function isPlaceholder(value) {
  return !value || value.trim() === "" || value.startsWith("your-");
}

async function searchTravelPolicies(query) {
  if (
    isPlaceholder(process.env.VOYAGE_API_KEY) ||
    isPlaceholder(process.env.KNOWLEDGE_BASE_URL) ||
    isPlaceholder(process.env.BLOB_READ_WRITE_TOKEN)
  ) {
    return "Policy search is not configured on this server (missing VOYAGE_API_KEY, KNOWLEDGE_BASE_URL, or BLOB_READ_WRITE_TOKEN). Answer from general travel knowledge and clearly say this is general guidance, not Voyagent's specific policy.";
  }
  try {
    const { chunks, embeddings } = await ensureKnowledgeBaseEmbeddings();
    const [queryEmbedding] = await embedTexts([query], "query");
    const ranked = chunks
      .map((chunk, i) => ({ chunk, score: cosineSimilarity(queryEmbedding, embeddings[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    return ranked.map((r) => `### ${r.chunk.heading}\n${r.chunk.text}`).join("\n\n---\n\n");
  } catch (err) {
    return `Policy search failed: ${err.message}. Answer from general travel knowledge and note that you could not confirm Voyagent's specific policy.`;
  }
}

async function runTool(name, input) {
  if (name === "search_travel_policies") {
    return searchTravelPolicies((input && input.query) || "");
  }
  return `Unknown tool: ${name}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
    return;
  }

  const { messages: clientMessages } = req.body || {};
  if (!Array.isArray(clientMessages) || clientMessages.length === 0 || !clientMessages.every(isValidMessage)) {
    res.status(400).json({ error: "Request must include a non-empty 'messages' array of {role, content}." });
    return;
  }
  if (clientMessages.length > 40) {
    res.status(400).json({ error: "Conversation is too long for this demo." });
    return;
  }

  const client = new Anthropic({ apiKey });

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });

  const messages = clientMessages.map((m) => ({ role: m.role, content: m.content }));

  try {
    let round = 0;
    while (true) {
      round += 1;
      const useTools = round <= MAX_TOOL_ROUNDS;
      const stream = client.messages.stream({
        model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        ...(useTools ? { tools: TOOLS } : {}),
      });

      stream.on("text", (text) => {
        res.write(text);
      });

      const finalMessage = await stream.finalMessage();

      if (finalMessage.stop_reason !== "tool_use" || !useTools) {
        break;
      }

      const toolUses = finalMessage.content.filter((b) => b.type === "tool_use");
      messages.push({ role: "assistant", content: finalMessage.content });

      const toolResults = [];
      for (const tu of toolUses) {
        res.write(`\n\n[[TOOL:${tu.name}]]`);
        const output = await runTool(tu.name, tu.input);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }
      messages.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    const message = (err && err.message) || "Something went wrong talking to Claude.";
    // Headers are already flushed (this is a streaming response), so a
    // clean HTTP error status isn't possible here — write a marker the
    // client-side widget knows to treat as an error instead.
    res.write(`\n\n[[ERROR]] ${message}`);
  } finally {
    res.end();
  }
};
