#!/usr/bin/env python3
"""Terminal travel agent powered by Claude.

Run it with:  python agent-demo2.py

It asks a few questions about your trip, then uses Claude to suggest
destinations, flight guidance, and a rough itinerary. After the first
suggestion you can keep asking follow-up questions in the same session.
"""

import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Claude's replies can include characters (em dashes, arrows, curly quotes)
# that the default Windows console codepage (cp1252) can't encode, which
# crashes a plain print(). Force UTF-8 with a safe fallback instead.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

try:
    import anthropic
except ImportError:
    print("Missing dependency 'anthropic'. Install it with:\n    pip install -r requirements.txt")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
ENV_FILE = SCRIPT_DIR / "config.env"
DEFAULT_MODEL = "claude-sonnet-5"
MAX_TOKENS = 2000
MAX_TOOL_ROUNDS = 3
VOYAGE_MODEL = "voyage-3.5"

SYSTEM_PROMPT = """You are an expert, friendly travel agent helping someone plan a vacation.

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
bullet points so it reads well in a plain terminal (no tables)."""

TOOLS = [
    {
        "name": "search_travel_policies",
        "description": (
            "Search Voyagent's cancellation, baggage, and travel insurance policy "
            "knowledge base. Call this when the traveler asks about cancellations, "
            "refunds, baggage allowances/fees, lost or delayed luggage, or travel "
            "insurance coverage/claims. Do not call it for general destination, "
            "itinerary, or flight-guidance questions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A focused search query describing what policy information is needed.",
                }
            },
            "required": ["query"],
        },
    }
]

_kb_cache = {}


def _chunk_markdown(markdown: str) -> list:
    chunks = []
    current = None
    for line in markdown.split("\n"):
        match = re.match(r"^##\s+(.*)", line)
        if match:
            if current:
                chunks.append(current)
            current = {"heading": match.group(1).strip(), "lines": [line]}
        elif current:
            current["lines"].append(line)
    if current:
        chunks.append(current)
    result = []
    for c in chunks:
        text = "\n".join(c["lines"]).strip()
        if text:
            result.append({"heading": c["heading"], "text": text})
    return result


def _voyage_embed(texts: list, input_type: str) -> list:
    api_key = os.environ.get("VOYAGE_API_KEY", "").strip()
    body = json.dumps({"input": texts, "model": VOYAGE_MODEL, "input_type": input_type}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.voyageai.com/v1/embeddings",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    ordered = sorted(data["data"], key=lambda d: d["index"])
    return [d["embedding"] for d in ordered]


def _cosine_similarity(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _ensure_knowledge_base_embeddings() -> dict:
    url = os.environ.get("KNOWLEDGE_BASE_URL", "").strip()
    if _kb_cache.get("url") == url and _kb_cache:
        return _kb_cache
    token = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        markdown = resp.read().decode("utf-8")
    chunks = _chunk_markdown(markdown)
    embeddings = _voyage_embed([c["text"] for c in chunks], "document")
    _kb_cache.clear()
    _kb_cache.update({"url": url, "chunks": chunks, "embeddings": embeddings})
    return _kb_cache


def _is_placeholder(value: str) -> bool:
    value = (value or "").strip()
    return not value or value.startswith("your-")


def search_travel_policies(query: str) -> str:
    if (
        _is_placeholder(os.environ.get("VOYAGE_API_KEY", ""))
        or _is_placeholder(os.environ.get("KNOWLEDGE_BASE_URL", ""))
        or _is_placeholder(os.environ.get("BLOB_READ_WRITE_TOKEN", ""))
    ):
        return (
            "Policy search is not configured on this server (missing VOYAGE_API_KEY, "
            "KNOWLEDGE_BASE_URL, or BLOB_READ_WRITE_TOKEN). Answer from general travel "
            "knowledge and clearly say this is general guidance, not Voyagent's specific policy."
        )
    try:
        kb = _ensure_knowledge_base_embeddings()
        query_embedding = _voyage_embed([query], "query")[0]
        ranked = sorted(
            zip(kb["chunks"], kb["embeddings"]),
            key=lambda pair: _cosine_similarity(query_embedding, pair[1]),
            reverse=True,
        )[:2]
        return "\n\n---\n\n".join(f"### {c['heading']}\n{c['text']}" for c, _ in ranked)
    except (urllib.error.URLError, KeyError, ValueError) as e:
        return (
            f"Policy search failed: {e}. Answer from general travel knowledge and note "
            "that you could not confirm Voyagent's specific policy."
        )


def run_tool(name: str, tool_input: dict) -> str:
    if name == "search_travel_policies":
        return search_travel_policies(tool_input.get("query", ""))
    return f"Unknown tool: {name}"


def load_env_file(path: Path) -> None:
    """Minimal .env loader — avoids adding a python-dotenv dependency."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


def get_client() -> anthropic.Anthropic:
    load_env_file(ENV_FILE)
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key or api_key == "your-api-key-here":
        print("No Anthropic API key configured.\n")
        print(f"1. Get a key from https://console.anthropic.com/settings/keys")
        print(f"2. Open {ENV_FILE} and set ANTHROPIC_API_KEY=<your-key>\n")
        sys.exit(1)
    return anthropic.Anthropic(api_key=api_key)


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return value or default


def collect_trip_details() -> dict:
    print("Answer a few quick questions (press Enter to accept the default).\n")
    details = {
        "origin": ask("Departure city / airport"),
        "travelers": ask("Number of travelers", "1"),
        "duration": ask("Trip length (e.g. 5 days, 1 week)", "1 week"),
        "dates": ask("Travel dates or month (blank = flexible)", "flexible"),
        "budget": ask("Approximate total budget (include currency)", "flexible"),
        "style": ask("Trip vibe (beach, adventure, city break, relaxation, culture, nightlife...)", "open to anything"),
        "domestic_intl": ask("Domestic, international, or either?", "either"),
        "must_have": ask("Any destination in mind, or open to suggestions?", "open to suggestions"),
        "constraints": ask("Any constraints? (kids, mobility, visas, dietary...)", "none"),
    }
    print()
    return details


def build_user_message(details: dict) -> str:
    return (
        "Plan a vacation for me with these details:\n"
        f"- Departing from: {details['origin'] or 'not specified'}\n"
        f"- Number of travelers: {details['travelers']}\n"
        f"- Trip length: {details['duration']}\n"
        f"- Travel dates: {details['dates']}\n"
        f"- Budget: {details['budget']}\n"
        f"- Preferred vibe/interests: {details['style']}\n"
        f"- Domestic or international: {details['domestic_intl']}\n"
        f"- Destination preference: {details['must_have']}\n"
        f"- Constraints: {details['constraints']}\n\n"
        "Please recommend destinations and flight guidance as instructed."
    )


def run_agent_turn(client: anthropic.Anthropic, messages: list) -> str:
    print("Travel Agent:\n")
    round_num = 0
    final_message = None
    while True:
        round_num += 1
        use_tools = round_num <= MAX_TOOL_ROUNDS
        stream_kwargs = dict(
            model=os.environ.get("CLAUDE_MODEL", DEFAULT_MODEL),
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        if use_tools:
            stream_kwargs["tools"] = TOOLS

        with client.messages.stream(**stream_kwargs) as stream:
            for text in stream.text_stream:
                print(text, end="", flush=True)
            final_message = stream.get_final_message()

        if final_message.stop_reason != "tool_use" or not use_tools:
            break

        tool_uses = [b for b in final_message.content if b.type == "tool_use"]
        messages.append({"role": "assistant", "content": final_message.content})

        tool_results = []
        for tu in tool_uses:
            print("\n\n[Searching Voyagent policies...]", flush=True)
            output = run_tool(tu.name, tu.input)
            tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": output})
        messages.append({"role": "user", "content": tool_results})

    print("\n")
    return "".join(block.text for block in final_message.content if block.type == "text")


def main() -> None:
    client = get_client()

    print("=" * 60)
    print("  Claude Travel Agent - Vacation Planner")
    print("=" * 60)
    print("I'll suggest destinations, flight guidance, and a rough")
    print("itinerary based on your answers. Ctrl+C any time to quit.\n")

    details = collect_trip_details()
    messages = [{"role": "user", "content": build_user_message(details)}]

    try:
        reply = run_agent_turn(client, messages)
    except anthropic.AuthenticationError:
        print(f"Authentication failed - check ANTHROPIC_API_KEY in {ENV_FILE}.")
        sys.exit(1)
    except anthropic.APIError as e:
        print(f"Anthropic API error: {e}")
        sys.exit(1)

    messages.append({"role": "assistant", "content": reply})

    print("-" * 60)
    print("Ask a follow-up (e.g. 'cheaper options', 'more adventurous'),")
    print("or type 'exit' to quit.\n")

    while True:
        try:
            follow_up = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nHappy travels!")
            break

        if not follow_up:
            continue
        if follow_up.lower() in {"exit", "quit", "q"}:
            print("Happy travels!")
            break

        turn_start = len(messages)
        messages.append({"role": "user", "content": follow_up})
        try:
            reply = run_agent_turn(client, messages)
        except anthropic.APIError as e:
            print(f"Anthropic API error: {e}")
            del messages[turn_start:]
            continue
        messages.append({"role": "assistant", "content": reply})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nHappy travels!")
