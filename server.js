/* server.js - the free-hosted bridge between your phone and Z.ai.
 *
 *   GET  /        -> the phone voice page (Puter does STT + TTS)
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

/* The phone voice page. Puter (puter.js - keyless, "user pays")
 * does both voices: a MediaRecorder mic capture goes to
 * puter.ai.speech2txt (STT) and the reply is spoken by
 * puter.ai.txt2speech (TTS). The browser's built-in Web Speech
 * API stays as a silent fallback if puter.js is unreachable or
 * sign-in is skipped. Needs HTTPS, which the free host provides
 * out of the box. */
const VOICE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 Voice Bridge</title>
<script src="https://js.puter.com/v2/"></script>
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
 <small>mic + speaker: Puter (puter.js) - keyless, one free sign-in<br>
  brain: glm-4.7-flash, thinking off - memory: 10-min timeout</small>
<script>
 var mic = document.getElementById("mic");
 var statusEl = document.getElementById("status");
 var transEl = document.getElementById("transcript");
 var replyEl = document.getElementById("reply");
 var havePuter = typeof puter !== "undefined" && !!puter.ai &&
                 !!puter.ai.speech2txt && !!puter.ai.txt2speech;
 var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
 var mode = null, listening = false;
 var rec = null, recorder = null, chunks = [], stream = null, stopTimer = null;
 function setBusy(b) { mic.classList.toggle("listening", b); }
 function speakFallback(t) {
   try {
     var u = new SpeechSynthesisUtterance(t);
     speechSynthesis.speak(u);
   } catch (e) {}
 }
 function speak(t) {
   if (!havePuter) { speakFallback(t); return; }
   puter.ai.txt2speech(t).then(function (audio) {
     var p = audio.play();
     if (p && p.catch) p.catch(function () {
       statusEl.textContent = "Tap anywhere to hear the reply.";
       document.body.onclick = function () {
         document.body.onclick = null;
         try { audio.play(); } catch (e) {}
       };
     });
   }).catch(function () { speakFallback(t); });
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
 /* STT path 1 - Puter: MediaRecorder captures the mic, puter.ai
    speech2txt transcribes the blob (a real model, not the
    browser's built-in one - and it works on iOS Safari). */
 function startRec() {
   navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
     stream = s;
     chunks = [];
     recorder = new MediaRecorder(s);
     recorder.ondataavailable = function (e) {
       if (e.data && e.data.size) chunks.push(e.data);
     };
     recorder.onstop = sendAudio;
     recorder.start();
     listening = true;
     setBusy(true);
     statusEl.textContent = "Listening... tap again to send.";
     stopTimer = setTimeout(stopRec, 15000);
   }).catch(function (e) {
     statusEl.textContent = "Mic blocked: " + e + (SR ? " - using browser STT." : "");
     if (SR) startSR();
   });
 }
 function stopRec() {
   clearTimeout(stopTimer);
   if (recorder && recorder.state === "recording") recorder.stop();
   else { listening = false; setBusy(false); }
 }
 function sendAudio() {
   listening = false;
   setBusy(false);
   if (stream) {
     stream.getTracks().forEach(function (t) { t.stop(); });
     stream = null;
   }
   if (!chunks.length) { statusEl.textContent = "Nothing recorded."; return; }
   var blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
   var ext = blob.type.indexOf("mp4") >= 0 ? "mp4" : "webm";
   var file = new File([blob], "speech." + ext, { type: blob.type });
   statusEl.textContent = "Transcribing with Puter...";
   puter.ai.speech2txt(file).then(function (t) {
     var text = (t && t.text) ? t.text : String(t);
     transEl.textContent = "You: " + text;
     ask(text);
   }).catch(function (e) {
     statusEl.textContent = "Puter STT error: " + ((e && e.message) || e) +
       " - tap to retry.";
   });
 }
 /* STT path 2 - the browser's Web Speech API, used only when
    puter.js did not load or the sign-in was skipped. */
 function startSR() {
   if (!rec) {
     rec = new SR();
     rec.lang = "en-US";
     rec.interimResults = false;
     rec.maxAlternatives = 1;
     rec.onstart = function () {
       listening = true;
       setBusy(true);
       statusEl.textContent = "Listening (browser STT)...";
     };
     rec.onresult = function (e) {
       var text = e.results[0][0].transcript;
       transEl.textContent = "You: " + text;
       ask(text);
     };
     rec.onerror = function (e) {
       statusEl.textContent = "Mic error: " + e.error;
     };
     rec.onend = function () { listening = false; setBusy(false); };
   }
   try { rec.start(); } catch (e) {}
 }
 /* One mic button, two engines. The first-ever tap opens ONE free
    Puter sign-in (the User-Pays model - no API keys anywhere). */
 if (!havePuter && !SR) {
   statusEl.textContent = "No Puter and no SpeechRecognition - " +
     "open this page online in a normal browser.";
 } else {
   mic.onclick = function () {
     if (listening) {
       if (mode === "puter") stopRec();
       else { try { rec.stop(); } catch (e) {} }
       return;
     }
     mode = havePuter ? "puter" : "sr";
     if (mode === "sr") { startSR(); return; }
     var signed = false;
     try { signed = puter.auth.isSignedIn(); } catch (e) { signed = false; }
     if (signed) { startRec(); return; }
     statusEl.textContent = "One-time Puter sign-in (free)...";
     puter.auth.signIn().then(function () {
       startRec();
     }).catch(function () {
       statusEl.textContent = "Sign-in skipped - using browser STT.";
       mode = SR ? "sr" : null;
       if (mode) startSR();
       else statusEl.textContent = "Sign-in skipped and no browser STT - reload online.";
     });
   };
 }
 var resetBtn = document.getElementById("reset");
 resetBtn.onclick = function () {
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
