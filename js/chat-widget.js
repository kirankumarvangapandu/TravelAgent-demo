/* =========================================================
   Voyagent floating chat widget
   Mirrors agent-demo2.py: same question sequence, same combined
   message sent to Claude, same streamed-reply + follow-up loop —
   just running in the browser against /api/chat instead of stdin.
   ========================================================= */
(function () {
  "use strict";

  const QUESTIONS = [
    { key: "origin", prompt: "Where are you departing from? (city or airport)", default: "" },
    { key: "travelers", prompt: "How many travelers?", default: "1", quick: ["1", "2", "4"] },
    { key: "duration", prompt: "How long is the trip? (e.g. 5 days, 1 week)", default: "1 week", quick: ["3-4 days", "1 week", "2 weeks"] },
    { key: "dates", prompt: "Travel dates or month? (leave blank if flexible)", default: "flexible" },
    { key: "budget", prompt: "Approximate total budget? (include currency)", default: "flexible" },
    { key: "style", prompt: "What's the vibe? (beach, adventure, city break, relaxation, culture, nightlife...)", default: "open to anything", quick: ["Beach & relaxation", "Adventure", "City break", "Culture & food"] },
    { key: "domestic_intl", prompt: "Domestic, international, or either?", default: "either", quick: ["Domestic", "International", "Either"] },
    { key: "must_have", prompt: "Any destination in mind, or open to suggestions?", default: "open to suggestions" },
    { key: "constraints", prompt: "Any constraints? (kids, mobility, visas, dietary...)", default: "none" },
  ];

  const toggleBtn = document.getElementById("widgetToggle");
  const panel = document.getElementById("widgetPanel");
  const body = document.getElementById("widgetBody");
  const quickRow = document.getElementById("widgetQuick");
  const input = document.getElementById("widgetInput");
  const sendBtn = document.getElementById("widgetSend");
  const resetBtn = document.getElementById("widgetReset");

  let state = null;

  function freshState() {
    return { step: 0, details: {}, messages: [], mode: "onboarding", busy: false, started: false };
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Tiny dependency-free renderer for the subset of markdown Claude tends to
  // use in these replies: #/##/### headings, **bold**, "- " bullet lists,
  // and blank-line paragraphs. Escapes HTML first so streamed text can never
  // inject markup.
  function renderMarkdownLite(raw) {
    const lines = escapeHtml(raw).replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let inList = false;
    const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    for (const line of lines) {
      const heading = /^(#{1,3})\s+(.*)/.exec(line);
      const bullet = /^[-*]\s+(.*)/.exec(line);
      if (heading) {
        closeList();
        const level = heading[1].length === 1 ? 4 : heading[1].length === 2 ? 4 : 5;
        html += `<h${level}>${inline(heading[2])}</h${level}>`;
      } else if (bullet) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += `<li>${inline(bullet[1])}</li>`;
      } else if (line.trim() === "") {
        closeList();
      } else {
        closeList();
        html += `<p>${inline(line)}</p>`;
      }
    }
    closeList();
    return html;
  }

  function addBubble(role, text) {
    const el = document.createElement("div");
    el.className = "msg msg-" + role;
    if (role === "assistant") {
      el.innerHTML = renderMarkdownLite(text);
    } else {
      el.textContent = text;
    }
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function addTyping() {
    const el = document.createElement("div");
    el.className = "msg-typing";
    el.innerHTML = "<i></i><i></i><i></i>";
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function setQuick(options) {
    quickRow.innerHTML = "";
    options.forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt.label;
      b.addEventListener("click", opt.onClick);
      quickRow.appendChild(b);
    });
  }

  function clearQuick() { quickRow.innerHTML = ""; }
  function currentQuestion() { return QUESTIONS[state.step]; }

  function askCurrentQuestion() {
    const q = currentQuestion();
    addBubble("assistant", q.prompt + (q.default ? ` (default: ${q.default})` : ""));
    input.placeholder = q.default ? `Default: ${q.default}` : "Type your answer…";

    const chips = (q.quick || []).map((label) => ({ label, onClick: () => submitAnswer(label) }));
    if (q.default) chips.push({ label: `Use default (${q.default})`, onClick: () => submitAnswer(q.default) });
    setQuick(chips);
  }

  function submitAnswer(rawText) {
    const q = currentQuestion();
    const text = (rawText != null ? rawText : input.value).trim();
    const value = text || q.default;
    addBubble("user", text || `(default: ${q.default || "none"})`);
    state.details[q.key] = value;
    input.value = "";
    autoGrow();
    clearQuick();

    state.step += 1;
    if (state.step < QUESTIONS.length) {
      askCurrentQuestion();
    } else {
      finishOnboarding();
    }
  }

  function buildUserMessage(details) {
    return (
      "Plan a vacation for me with these details:\n" +
      `- Departing from: ${details.origin || "not specified"}\n` +
      `- Number of travelers: ${details.travelers}\n` +
      `- Trip length: ${details.duration}\n` +
      `- Travel dates: ${details.dates}\n` +
      `- Budget: ${details.budget}\n` +
      `- Preferred vibe/interests: ${details.style}\n` +
      `- Domestic or international: ${details.domestic_intl}\n` +
      `- Destination preference: ${details.must_have}\n` +
      `- Constraints: ${details.constraints}\n\n` +
      "Please recommend destinations and flight guidance as instructed."
    );
  }

  async function finishOnboarding() {
    state.mode = "chat";
    state.messages.push({ role: "user", content: buildUserMessage(state.details) });
    await sendToClaude();
    input.placeholder = "Ask a follow-up…";
    setQuick([
      { label: "Cheaper options", onClick: () => quickFollowUp("Can you suggest cheaper options?") },
      { label: "More adventurous", onClick: () => quickFollowUp("Make the suggestions more adventurous.") },
      { label: "More detail", onClick: () => quickFollowUp("Can you give more detail on the top pick?") },
    ]);
  }

  function quickFollowUp(text) {
    clearQuick();
    sendUserText(text);
  }

  async function sendUserText(text) {
    if (!text || state.busy) return;
    addBubble("user", text);
    state.messages.push({ role: "user", content: text });
    input.value = "";
    autoGrow();
    await sendToClaude();
  }

  const TOOL_MARKER_RE = /\[\[TOOL:[^\]]*\]\]/g;

  function stripToolMarkers(text) {
    return text.replace(TOOL_MARKER_RE, "").trim();
  }

  // True while the stream's most recent event is a tool-call marker with no
  // reply text after it yet — i.e. Claude is off running search_travel_policies.
  function isAwaitingToolResult(text) {
    const matches = [...text.matchAll(TOOL_MARKER_RE)];
    if (!matches.length) return false;
    const last = matches[matches.length - 1];
    return text.slice(last.index + last[0].length).trim().length === 0;
  }

  // Streams one assistant reply for the given request messages, handling the
  // typing indicator, the "searching policies" state, and the [[ERROR]] marker.
  // Returns { ok, text } — text is the clean reply on success.
  async function runStream(requestMessages) {
    const typingEl = addTyping();
    let assistantEl = null;
    let searchingEl = null;
    let fullText = "";
    let sawError = false;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: requestMessages }),
      });

      if (!res.ok || !res.body) {
        const errJson = await res.json().catch(() => null);
        throw new Error((errJson && errJson.error) || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });

        if (fullText.includes("[[ERROR]]")) {
          sawError = true;
          break;
        }

        if (isAwaitingToolResult(fullText)) {
          if (assistantEl) { assistantEl.remove(); assistantEl = null; }
          if (!searchingEl) {
            typingEl.remove();
            searchingEl = addBubble("assistant", "");
            searchingEl.classList.add("msg-searching");
            searchingEl.textContent = "Searching Voyagent policies…";
          }
        } else {
          if (searchingEl) { searchingEl.remove(); searchingEl = null; }
          if (!assistantEl) {
            typingEl.remove();
            assistantEl = addBubble("assistant", "");
          }
          assistantEl.innerHTML = renderMarkdownLite(stripToolMarkers(fullText));
        }
        body.scrollTop = body.scrollHeight;
      }
    } catch (err) {
      typingEl.remove();
      if (assistantEl) assistantEl.remove();
      if (searchingEl) searchingEl.remove();
      addBubble("error", "Sorry - " + (err.message || "something went wrong. Please try again."));
      return { ok: false };
    }

    typingEl.remove();

    if (sawError) {
      if (assistantEl) assistantEl.remove();
      if (searchingEl) searchingEl.remove();
      const idx = fullText.indexOf("[[ERROR]]");
      const cleanBefore = stripToolMarkers(fullText.slice(0, idx));
      if (cleanBefore) addBubble("assistant", cleanBefore);
      const errMsg = fullText.slice(idx + "[[ERROR]]".length).trim();
      addBubble("error", "Sorry - " + (errMsg || "something went wrong. Please try again."));
      return { ok: false };
    }

    const cleanText = stripToolMarkers(fullText);
    if (searchingEl) searchingEl.remove();
    if (!assistantEl) assistantEl = addBubble("assistant", "");
    assistantEl.innerHTML = renderMarkdownLite(cleanText);
    return { ok: true, text: cleanText };
  }

  async function sendToClaude() {
    state.busy = true;
    setSendEnabled(false);
    const result = await runStream(state.messages);
    if (result.ok) state.messages.push({ role: "assistant", content: result.text });
    state.busy = false;
    setSendEnabled(true);
  }

  // Heuristic: does this look like a question aimed at the agent (e.g. about
  // policies) rather than an answer to the current onboarding prompt? Lets the
  // user ask about cancellation/baggage/insurance before finishing the trip
  // questionnaire.
  function looksLikeAgentQuestion(text) {
    if (/\?/.test(text)) return true;
    return /\b(polic(?:y|ies)|cancel|cancellation|refunds?|baggage|luggage|carry[- ]?on|checked bags?|insurance|claims?|coverage|allowances?|fees?|prohibited|liquids)\b/i.test(
      text
    );
  }

  // Answers a one-off question during onboarding without consuming the current
  // trip question, then re-asks it so the user can continue where they left off.
  async function answerSideQuestion(text) {
    if (state.busy) return;
    addBubble("user", text);
    input.value = "";
    autoGrow();
    clearQuick();
    state.busy = true;
    setSendEnabled(false);
    await runStream([{ role: "user", content: text }]);
    state.busy = false;
    setSendEnabled(true);
    addBubble("assistant", "Back to planning your trip 👇");
    askCurrentQuestion();
  }

  function setSendEnabled(enabled) { sendBtn.disabled = !enabled; }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 90) + "px";
  }

  function handleSendClick() {
    if (state.busy) return;
    if (state.mode === "onboarding") {
      const text = input.value.trim();
      if (text && looksLikeAgentQuestion(text)) {
        answerSideQuestion(text);
      } else {
        submitAnswer(text);
      }
    } else {
      const text = input.value.trim();
      if (text) sendUserText(text);
    }
  }

  function startConversation() {
    state = freshState();
    body.innerHTML = "";
    clearQuick();
    input.placeholder = "Type your answer…";
    addBubble(
      "assistant",
      "Hi! I'm Voyagent. Let's plan your trip - answer a few quick questions (or tap a default) and I'll suggest destinations and flights. You can also ask me about our cancellation, baggage, or insurance policies anytime."
    );
    askCurrentQuestion();
    state.started = true;
  }

  function openWidget() {
    panel.classList.add("open");
    toggleBtn.classList.add("open");
    if (!state || !state.started) startConversation();
    input.focus();
  }

  function closeWidget() {
    panel.classList.remove("open");
    toggleBtn.classList.remove("open");
  }

  toggleBtn.addEventListener("click", () => {
    if (panel.classList.contains("open")) closeWidget();
    else openWidget();
  });

  document.querySelectorAll("[data-open-widget]").forEach((el) => el.addEventListener("click", openWidget));
  resetBtn.addEventListener("click", startConversation);
  sendBtn.addEventListener("click", handleSendClick);
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendClick();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) closeWidget();
  });
})();
