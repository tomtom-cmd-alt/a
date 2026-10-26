/* server.js - the free-hosted bridge between your phone and Z.ai.
 *
 *   GET  /        -> the phone voice page (browser mic + speaker)
 *   GET  /status  -> {"status":"awake","uptime_s":N,"history_turns":N}
 *                    (the ESP32's 'pingserver' reads exactly this)
 *   POST /chat    -> {"text":"hello"} -> {"reply":"..."} (with memory)
 *   POST /reset   -> wipes the bridge's conversation memory
 *
 * Deploy free on Render (sleeps when idle - "not online when I am
 * not using it"): push this file + package.json to a GitHub repo,
 * Render.com -> New + Web Service -> pick the repo -> Build command
 * "npm install", Start command "node server.js" -> Environment:
 * add ZAI_API_KEY -> Deploy. Free HTTPS included.
 *
 * Needs Node 18+ (built-in fetch). No database on purpose: memory
 * is RAM, wiped by /reset, a restart, or 10 idle minutes - the same
 * rule the ESP32 sketch uses.
 */

const express = require("express");
const app = express();
app.use(express.json({ limit: "64kb" }));

const ZAI_KEY   = process.env.ZAI_API_KEY || "";
const ZAI_URL   = process.env.ZAI_URL ||
  "https://api.z.ai/api/paas/v4/chat/completions";
const ZAI_MODEL = process.env.ZAI_MODEL || "glm-4.7-flash";
const MAX_TURNS = 10;              /* 5 user + 5 assistant turns */
const IDLE_MS   = 10 * 60 * 1000;  /* 10-minute timeout          */

const history = [];
let   lastTalk = Date.now();
const bornAt   = Date.now();

function idleWipe() {
  if (history.length && Date.now() - lastTalk > IDLE_MS) {
    history.length = 0;
  }
}

app.get("/status", (req, res) => {
  idleWipe();
  res.json({
    status: "awake",
    uptime_s: Math.round((Date.now() - bornAt) / 1000),
    history_turns: Math.round(history.length / 2),
    thinking: "disabled",
    model: ZAI_MODEL,
  });
});

app.post("/reset", (req, res) => {
  history.length = 0;
  res.json({ ok: true, history_turns: 0 });
});

app.post("/chat", async (req, res) => {
  idleWipe();
  const text = String(
    (req.body && (req.body.text || req.body.prompt)) || ""
  ).trim();
  if (!text) {
    return res.status(400).json({ error: "no text - send a JSON body with a text field" });
  }
  if (!ZAI_KEY) {
    return res.status(500).json({ error: "no ZAI_API_KEY env var on the server" });
  }

  const messages = history.slice();          /* replay the memory */
  messages.push({ role: "user", content: text });

  try {
    const r = await fetch(ZAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + ZAI_KEY,
      },
      body: JSON.stringify({
        model: ZAI_MODEL,
        max_tokens: 300,
        thinking: { type: "disabled" },  /* no chain-of-thought burn */
        messages: messages,
      }),
    });
    const data = await r.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    const reply = (msg && (msg.content || msg.reasoning_content)) ||
      "(empty reply)";
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: reply });
    while (history.length > MAX_TURNS) history.shift();  /* ring */
    lastTalk = Date.now();
    res.json({ reply: reply, turns: Math.round(history.length / 2) });
  } catch (e) {
    res.status(502).json({ error: "provider call failed: " + e.message });
  }
});

/* The phone voice page. The browser's Web Speech API does STT (the
 * mic) and TTS (the speaker) - no app, no Home Assistant. It needs
 * HTTPS, which the free host provides out of the box. */
const VOICE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 Voice Bridge</title>
<style>
 body{font-family:system-ui;margin:0;min-height:100vh;display:flex;
      flex-direction:column;align-items:center;justify-content:center;
      gap:14px;padding:24px;background:#0f172a;color:#e2e8f0}
 #mic{width:128px;height:128px;border-radius:999px;border:0;
      font-size:44px;background:#10b981;cursor:pointer}
 #mic.listening{background:#f59e0b;animation:pulse 1s infinite}
 @keyframes pulse{50%{opacity:.55}}
 #status{min-height:1.2em;color:#94a3b8;font-size:14px;text-align:center}
 #transcript,#reply{max-width:34rem;text-align:center;line-height:1.5}
 #reply{color:#5eead4;font-weight:600;min-height:1.5em}
 #reset{background:#1e293b;color:#94a3b8;border:1px solid #334155;
        border-radius:8px;padding:8px 14px}
 small{color:#64748b;text-align:center}
</style>
</head>
<body>
 <h1 style="font-size:18px;margin:0">ESP32 Voice Bridge</h1>
 <button id="mic" aria-label="Tap and talk">&#127908;</button>
 <div id="status">Tap the mic and speak.</div>
 <div id="transcript"></div>
 <div id="reply"></div>
 <button id="reset">Reset memory</button>
 <small>mic + speaker: your browser (Web Speech API)<br>
  brain: glm-4.7-flash, thinking off - memory: 10-min timeout</small>
<script>
 var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
 var mic = document.getElementById("mic");
 var statusEl = document.getElementById("status");
 var transEl = document.getElementById("transcript");
 var replyEl = document.getElementById("reply");
 function speak(t) {
   try {
     var u = new SpeechSynthesisUtterance(t);
     speechSynthesis.speak(u);
   } catch (e) {}
 }
 function ask(text) {
   statusEl.textContent = "Thinking...";
   fetch("/chat", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ text: text })
   })
     .then(function (r) { return r.json(); })
     .then(function (d) {
       if (d.reply) {
         replyEl.textContent = d.reply;
         speak(d.reply);
         statusEl.textContent = "Done - tap to talk again.";
       } else {
         statusEl.textContent = "Error: " + (d.error || "unknown");
       }
     })
     .catch(function (e) {
       statusEl.textContent = "Network error: " + e;
     });
 }
 if (!SR) {
   statusEl.textContent =
     "This browser has no SpeechRecognition - use Chrome " +
     "(Android/desktop) or Safari on iOS 14.5+.";
 } else {
   var rec = new SR();
   rec.lang = "en-US";
   rec.interimResults = false;
   rec.maxAlternatives = 1;
   rec.onstart = function () {
     mic.classList.add("listening");
     statusEl.textContent = "Listening...";
   };
   rec.onresult = function (e) {
     var text = e.results[0][0].transcript;
     transEl.textContent = "You: " + text;
     ask(text);
   };
   rec.onerror = function (e) {
     statusEl.textContent = "Mic error: " + e.error;
   };
   rec.onend = function () { mic.classList.remove("listening"); };
   mic.onclick = function () {
     try { rec.start(); } catch (e) {}
   };
 }
 document.getElementById("reset").onclick = function () {
   fetch("/reset", { method: "POST" }).then(function () {
     transEl.textContent = "";
     replyEl.textContent = "";
     statusEl.textContent = "Memory reset - fresh start.";
   });
 };
</script>
</body>
</html>`;

app.get("/", (req, res) => res.type("html").send(VOICE_PAGE));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("bridge up on port " + port));
