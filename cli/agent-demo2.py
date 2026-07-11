#!/usr/bin/env python3
"""Terminal travel agent powered by Claude.

Run it with:  python agent-demo2.py

It asks a few questions about your trip, then uses Claude to suggest
destinations, flight guidance, and a rough itinerary. After the first
suggestion you can keep asking follow-up questions in the same session.
"""

import os
import sys
from pathlib import Path

try:
    import anthropic
except ImportError:
    print("Missing dependency 'anthropic'. Install it with:\n    pip install -r requirements.txt")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
ENV_FILE = SCRIPT_DIR / "config.env"
DEFAULT_MODEL = "claude-sonnet-5"
MAX_TOKENS = 2000

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

Keep the tone helpful and concise. Format the response with clear headings and
bullet points so it reads well in a plain terminal (no tables)."""


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


def stream_reply(client: anthropic.Anthropic, messages: list) -> str:
    print("Travel Agent:\n")
    reply_text = ""
    with client.messages.stream(
        model=os.environ.get("CLAUDE_MODEL", DEFAULT_MODEL),
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=messages,
    ) as stream:
        for text in stream.text_stream:
            print(text, end="", flush=True)
            reply_text += text
    print("\n")
    return reply_text


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
        reply = stream_reply(client, messages)
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

        messages.append({"role": "user", "content": follow_up})
        try:
            reply = stream_reply(client, messages)
        except anthropic.APIError as e:
            print(f"Anthropic API error: {e}")
            messages.pop()
            continue
        messages.append({"role": "assistant", "content": reply})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nHappy travels!")
