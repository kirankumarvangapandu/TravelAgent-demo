// Vercel serverless function (Node.js runtime).
// Mirrors agent-demo2.py: same system prompt, same model default, same
// streaming behaviour — just reachable over HTTP instead of a terminal.
const Anthropic = require("@anthropic-ai/sdk");

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 2000;

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

Keep the tone helpful and concise. Format the response with clear headings and
bullet points so it reads well in a compact chat widget (no tables).`;

function isValidMessage(m) {
  return (
    m &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string" &&
    m.content.trim().length > 0
  );
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

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isValidMessage)) {
    res.status(400).json({ error: "Request must include a non-empty 'messages' array of {role, content}." });
    return;
  }
  if (messages.length > 40) {
    res.status(400).json({ error: "Conversation is too long for this demo." });
    return;
  }

  const client = new Anthropic({ apiKey });

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });

  try {
    const stream = client.messages.stream({
      model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    });

    stream.on("text", (text) => {
      res.write(text);
    });

    await stream.finalMessage();
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
