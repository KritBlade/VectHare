# 🐰 VectHarePlus — Advanced RAG for SillyTavern

> *Perfect memory for your roleplay conversations.* VectHarePlus brings LLM-extracted chat events, native sparse-vector hybrid search, and smart memory decay to SillyTavern.

![Version](https://img.shields.io/badge/version-3.0.0-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Status](https://img.shields.io/badge/status-Active-brightgreen)

---

## 🎯 What is VectHarePlus?

Branched from the original VectHare project, VectHarePlus is an **advanced Retrieval-Augmented Generation (RAG) system** for SillyTavern, now featuring newly added, optimized support for Japanese, Traditional Chinese, and Simplified Chinese.

I branched the original VectHare to handle the massive scale of my personal MVU Game Maker projects, which feature:
- **Extreme scale: 2,000+ replies per story, with 1,000+ words per reply. Summary retrieval returns in less than 3 seconds**
- Non-English language support (Japanese, Traditional/Simplified Chinese). It supports English by default.
- Strip out all functional tag from MVU Game Maker.
- Super long term memory that actually works (2000+ messages)

Ordinary SillyTavern memory extensions completely buckle under this load, especially when there are a lot of functional tags reside inside the story used by MVU Game Maker, which is useless for memory lookup. So, I need something that is able to clean up all these functional tags while maintain high speed vectorization on extreme scale.

Most memory extensions are designed for chats with 100 messages or fewer, and they work perfectly well at that scale. But as the chat grows past that, they're forced to summarize older messages more and more aggressively. You end up with full detail on recent history and a heavily compressed blur for everything older — and there's no real way around it, because you simply can't fit 100+ messages worth of raw context into the prompt. Old memory *has* to be compressed, which means detail is lost.

Cars with square wheels will never solve the problem, no matter how much you fine-tune them. I need the right tool for the job. What I actually need is a dedicated vector database backend to properly store all these memories.

To tackle this, VectHarePlus uses a dedicated vector database that stores **every single meaningful event** from the chat. Whether it's the first message or the 2,000th, every meaningful event stays in the database and is always available for SillyTavern to search.  I want a production grade memory vector system for SillyTavern which is scalable to 10k+ messages and round trip time within seconds.

### The Problem It Solves

- 😩 Strip out all functional tags used by MVU Game Maker before memory storage.
- 🧠 Adding story based memory on top of character based memory in MVU Game Maker.
- 💸 Long conversations choke your token budget with irrelevant history
- ✍️ You manually edit context to remind characters of key events

**VectHarePlus Solution:** Use **Qdrant** as a dedicated vector database that stores every meaningful event from the chat, no matter how long it gets. For users who aren't ready to run an extra service, a **"light" version using the A1 and A2 paths** runs on SillyTavern's built-in vector store with no additional software — it shares many features of the full vector DB at smaller scale. When you're ready for a real long-term memory system, upgrade to the **A3 path** with Qdrant.

Note: Qdrant is free and open source

---

## 🧠 How It Works

Vector search is like a really smart "find" function. Instead of matching exact words, it matches **meaning** — type "I'm hungry" and it can find a message that said "let's grab lunch" because the *meaning* is similar.

VectHarePlus is built around two ideas that work together:

### 1. EventBase — events extracted from windows, not summary-per-reply

Most memory extensions take each/several AI replies and summarize it into one blob of text. That sounds fine until you look at what's actually in a reply:

- A 100-sentence reply might contain **5 meaningful events** (a fight, a discovery, a promise, an item swap, a relationship beat) buried in 95 sentences of filler dialogue, scene-setting, and chitchat
- Another reply might contain **zero events** — just banter
- A third might pack **3 events** into 20 sentences

Summary-per-reply flattens all three cases into "one blob per reply" — losing event boundaries, mixing important beats with filler, and producing the same data shape whether anything actually happened or not.

**EventBase looks at a window of recent messages and extracts 0, 1, or many structured events** depending on what actually occurred. Each event is its own record with rich metadata (`characters`, `locations`, `items`, `concepts`, `importance`, `DateTime`, etc.) — not just a description string.

If Tav had a long shopping trip with Astarion across 100 sentences of conversation among 3 other teammates and background story noise, EventBase might extract one event out of that wall of text:

```
{
  description: "Tav and Astarion shopped for armor in Baldur's Gate.
                Astarion mocked the prices. Tav bought a leather chestpiece for 80gp.",
  importance: 0.6,
  source_window: [msg 142 → 154]
}
```

Later when you mention "remember the shopping trip?", VectHarePlus retrieves **the event** — not 100 raw sentences, and not a blurry summary that averaged the shopping trip with the unrelated banter that surrounded it.

### 2. Why a dedicated vector DB is the natural fit

If you only do summary-per-reply, you don't really *need* a vector database. You're producing ~1 blob per reply, always the same shape, and you re-summarize them recursively as the chat grows. A simple text file would do — and that's exactly why many older memory extensions never bothered with a real DB.

But once you commit to EventBase, the picture changes:

- 2,000 replies → potentially **1,000–3,000 structured events** (some replies extract several, some extract none)
- Each event has rich fields: characters, locations, items, concepts, keywords, importance, timestamps
- You need to find the relevant 5–10 events by **meaning + keyword + metadata filtering**, in real time, while the user is mid-conversation

That's exactly the workload a **dedicated vector database like Qdrant is designed for**: many small structured records with both dense vector similarity and sparse keyword search, plus metadata filtering, plus global BM25 weighting across the full corpus. Trying to do this with a flat file of summaries would mean linear scans, no keyword indexing, no metadata filters, and no scale beyond a few hundred entries.

EventBase doesn't *force* you onto Qdrant — the A1/A2 light paths run on SillyTavern's built-in Vectra. But once your chat passes a few hundreds events, Qdrant is the storage layer that was actually built for this shape of data.

### 🧠 Why this beats traditional memory extensions

Most existing memory extensions use one of two approaches. Both lose detail as the chat grows. Here's why — and how EventBase avoids it:

| Aspect | 📝 Rolling Summary <br>*(most "memory" extensions)* | ✂️ Raw Chunking <br>*(older vector RAG)* | 🧬 EventBase <br>*(VectHarePlus)* |
|---|---|---|---|
| **What gets stored** | One ever-growing summary text | Every message cut into raw chunks | Structured event records with metadata |
| **At msg 100** | Mostly intact | Intact | Intact |
| **At msg 1,000** | Heavily compressed — names, numbers, and one-off details drift or vanish | Token budget overflow — older chunks score-pruned or dropped | **Intact** — old events still in DB, surfaced by relevance |
| **At msg 5,000+** | Effectively a blur | DB bloat; retrieval gets noisy because raw chunks are low signal | **Intact** — only the few events relevant to the current scene are pulled |
| **What "compression" does** | Re-summarizes the summary recursively, so every pass loses information | None — but no synthesis either; raw text is hit-or-miss for retrieval | One-time, semantic — extracts *the meaningful event* and drops filler. Detail in the event itself is preserved. |
| **Retrieval signal** | None — the whole summary is always injected | Vector similarity over raw text (catches paraphrases but also noise) | Vector + BM25 hybrid over rich fields (`characters`, `items`, `locations`, `concepts`, `keywords`, plus dense meaning) |
| **Where detail goes** | Lost forever once compressed | Lost when chunk drops below score threshold | **Doesn't go anywhere** — events live in the vector DB and surface when relevant |
| **What gets injected** | The whole running summary (every turn, every time) | A few semantically-close raw messages | Only the events that matter for the current message |

**The core insight:** rolling summaries lose detail because they *throw away* old content to make room. Raw chunking loses detail because *retrieval breaks* at scale. EventBase keeps every meaningful event around forever — and lets vector + keyword search decide which 5–10 of them are worth showing the AI right now. Detail isn't compressed; **irrelevance is filtered**.

---

## 🔍 Hybrid Search: A1 vs A2 vs A3 Path

VectHarePlus combines **two signals** to find the best results:

- **Signal 1 - Vector similarity** — meaning-based ("hungry" matches "let's grab lunch")
- **Signal 2 - BM25 keyword score** — exact word match ("Astarion" matches "Astarion")

There are **three paths** for combining them, depending on backend and settings:  (From your browser to dedicated vector database on a docker)

### A1 — Standard backend + BM25
Browser does a vector search to get the top ~100 candidates, then computes BM25 keyword scores on just those candidates. Simple weighted sum: `α × vectorScore + β × bm25Score`.

**Tradeoff:** Fast and lightweight for slower computer, but if a perfect keyword match was outside the top 100 vector results, it's invisible.

### A2 — Standard backend + Hybrid (Recommend for most users that doesn't go the A3 Path)
Same as A1, but adds:
- **RRF (Reciprocal Rank Fusion)** — combines results by *position* instead of raw score
- **Dual-signal bonus** — results that appear in *both* lists get up to +8% boost

**Example:** Searching "Astarion drinks blood." An event matched by both vector ("vampires/hunger") *and* BM25 (literal "Astarion" + "blood") gets ranked higher than events in only one list.

**Tradeoff:** Better fusion on browser with a faster computer, but still limited to the vector top-K 100 candidate pool. (It's still top 100 sample)

### A3 — Qdrant native sparse + server-side RRF (best)
Both searches run **inside Qdrant vector database in a single API call**. Each stored point has two vectors: a dense one (meaning) and a sparse one (keyword frequencies). Qdrant computes BM25 weights across the **full corpus** (true IDF, not biased), then fuses with native RRF. The keyword side isn't capped at the dense search's top results — if an event contains your query words, it's eligible, even if its meaning vector wasn't a close match. And the BM25 word-importance weights are calculated using statistics from **every event** in the database (not just a top-100 sample), so rare words get scored correctly.

**Example:** Searching "I cast Fireball at the dragon." Qdrant searches its dense index (for spell/attack meanings) and sparse index (for the literal words "Fireball" and "dragon") at the same time, fuses server-side, returns one ranked list.

**Tradeoff:** Best accuracy, fastest at scale. However, you need an additional docker running Qdrant vector database.

| Backend setting | Path you get |
|---|---|
| Standard (Vectra - standard SillyTavern vector format) + BM25 | A1 |
| Standard (Vectra  - standard SillyTavern vector format) + Hybrid | A2 |
| Qdrant (Dedicated Vector DB on a docker) | A3 |

---

## ✨ Features

### 🧬 EventBase — LLM-extracted chat memory
LLM summarizes chat into structured events with importance/recency/persistence weights. A 4-weight re-ranker decides what gets injected. Built-in dedup suppresses events already visible in recent messages.

Each event is a structured record, not raw text. Example of what the LLM produces from the Astarion shopping window:

```
event_type:    item_acquired
importance:    6
text:          Tav and Astarion shopped for armor in Baldur's Gate. Astarion mocked the prices.
               Tav bought a leather chestpiece for 80gp.
DateTime:      1492-08-15T14:00:00
cause:         Tav needed better armor before the Gauntlet of Shar expedition
result:        Tav now wears the leather chestpiece; 80gp spent from party funds
characters:    [Tav, Astarion]
locations:     [Baldur's Gate, Sorcerous Sundries district]
factions:      []
items:         [leather chestpiece, 80gp]
concepts:      [armor shopping, party economy]
keywords:      [armor, leather, chestpiece, gold, shopping]
open_threads:  [Gauntlet of Shar preparation]
should_persist: false
```

Both signals (meaning + keywords) operate over this rich field set, so a query like "armor for the dungeon" hits via concepts/open_threads, while "Astarion 80gp" hits via characters/items/keywords.  The structure is native to Qdrant vector database so that hit rate is WAY higher than any other kind of memory extension.

### 🌏 CJK language support (Japanese, Traditional/Simplified Chinese)
- Jieba WASM (Simplified + Traditional Chinese), TinySegmenter (Japanese), Intl.Segmenter (English/Latin/Korean)
- CJK tokenizer mode is **locked per Qdrant collection** at upsert — switching modes shows a warning modal

### 🔍 Native sparse-vector hybrid search (Qdrant)
A3 path described above — server-side RRF with globally-accurate BM25 IDF. Single round-trip per query.

### 📝 Summarize before store
Mandatory LLM summarization before vector storage. Supports OpenRouter and local vLLM-compatible endpoints. Configurable prompt template.

### ⏯️ Better vectorization controls
Stop button, pause/resume, fingerprint cache that survives Chrome restarts mid-run.

### 🔒 Per-chat collection scoping
New collections auto-activate for the current chat. "Active for current chat" checkbox controls the chat lock. Lock button in the Database Browser shows whether a lock is for *this* chat or another.

### 📡 Smarter status indicators
Auto-Sync card shows whether the current chat is vectorized and how many events exist. World Info card shows vectorized lorebooks by name. Both link to the right vectorizer if something's missing.

### 🗂️ Tabbed interface
Settings split into **Core** (backend, embedding, hybrid), **EventBase** (chat hsitory/archive chat file .jsonl), **ChunkBase** (lorebook/docs/URLs/wiki), **Action** (diagnostics, dev tools).

### ⚡ Parallel Windows — Vectorization Speedup
Vectorizing a long chat normally processes one window at a time: send window 1 to the LLM → wait → embed → send window 2 → wait → embed → ... For a 2000-message chat that's a lot of serialized waiting.

The **Parallel Windows** slider (Chunking Strategy section in Vectorize Content) lets you spawn up to **8 LLM extraction + embedding calls at the same time**. Window 1 is being extracted while windows 2–8 are also in flight, dramatically cutting total ingestion time.

| Slider value | Behavior |
|---|---|
| **1 (safe)** | One window at a time. Lowest provider load, no risk of rate limits, slowest. |
| **2–4** | Mild parallelism. Good middle ground for most providers. |
| **5–8 (fast)** | Aggressive parallelism. Best for cloud providers with high rate limits (OpenRouter, OpenAI, Cohere). May trip rate limits on free tiers. |

Use **1** if you're on a strict rate-limited free tier or a single local GPU. Crank to **8** if you're on a paid cloud provider and want a 2000-message chat ingested in minutes instead of an hour.

### 🧹 Multilingual keyword quality
Better single-character filtering for CJK, mode-specific exceptions for high-signal 1-character RPG/Slice of Life/school terms.

### 🧹 Major cleanup
Numerous bug fixes around mixed-backend search, handle ID filtering, and other enhancement from the original VectHare.

---

## 🎭 Activation Rules

Each collection card has an Activation panel. The priority chain is:

1. **Disabled** (pause button) → never queries
2. **Triggers** → keywords match recent messages → activates
3. **Advanced Conditions** → if triggers empty/no match, evaluate condition rules → activates 
4. **Active for current chat / Character lock** → manual always-on fallback
5. **Nothing matched** → does not activate

Conditions support emotion (via Character Expressions sprite detection), keywords, message/turn count, and combined AND/OR rules. 

> ⚠️ **CJK note:** Triggers and emotion/keyword conditions are **English-only** — the keyword dictionary is English and regex `\b` word boundaries don't fire between CJK characters. For Chinese/Japanese/Korean stories, use **"Active for current chat" / Character lock** instead. Message Count / Turn Count conditions are numeric and work fine for any language.

---

## ⏳ Temporal Decay

Older content gets a lower score so it only surfaces when really relevant.

```
relevance = original_score × (0.5 ^ (message_age / half_life))
```

With half-life = 50: a message 50 ago is at 50% relevance, 100 ago at 25%, 150 ago at 12.5%. Floor (default 0.3) prevents complete forgetting. Mark important chunks **temporally blind** to make them immune.  A3 Path should not need to use this feature because the whole point of using A3 path is to allow the backend search the complete database with no performance penalty.

> **EventBase note:** EventBase has its own built-in recency bonus in the 4-weight re-ranker. The standalone decay setting only affects non-chat content (lorebook, documents).

---

## 📦 Backends

| Backend | Best for | Notes |
|---|---|---|
| **Standard (Vectra - SillyTavern default vector format)** | Small datasets, multilingual, getting started | No dependencies. Limited to A1/A2 hybrid. |
| **Qdrant** | Large chats, multilingual, production | A3 hybrid (best accuracy). Requires Qdrant + Similharity plugin (installation below). |

Use **Qdrant vector database** for any ultra fast and accurate delopment — A3 is materially more accurate than A1/A2, especially for CJK, and it is free and opensource.  2000+ events in the database takes less than 3 seconds round trip search.

---

## 💾 Installation

### Step 1: Install the Extension

1. Open SillyTavern in your browser
2. Go to **Extensions** panel (puzzle piece icon)
3. Click **"Install Extension"**
4. Paste this URL:
   ```
   https://github.com/KritBlade/VectHarePlus
   ```
5. Click **Install**

That's it! VectHarePlus will be downloaded and enabled automatically.

### Step 2: Configure VectHarePlus
1. Open **VectHarePlus Settings** (Core tab in the extensions panel)
2. Choose your vector storage (Standard or Qdrant)
3. Select your embedding provider (Transformers, OpenAI, Ollama, BananaBread, etc.)
4. Select your summaizer LLM (Openrouter or vLLM)
5. Configure API keys if using cloud providers
6. Keyword Extraction choose the language of your story.
7. Most settings using default should be good, but feel free to tweak it.
8. Click in to your chat in SillyTavern, then click on VectHarePlus extension again.  You HAVE to click on "Vectorize Content" and choose Chat History to vectorize your first db.
9. Enable Auto-Sync if needed in AutoSync tab, the frequence is set in EventBase tab under "Extraction > Window Size"
10. Vectorize your lorebook/World Info if needed in WorldInfo tab.

### Step 3: (Needed for Qdrant backends ONLY) Install Similharity Plugin

```bash
cd SillyTavern/plugins
git clone -b Similharity-Plugin https://github.com/KritBlade/VectHarePlus.git similharity
cd similharity
npm install
```

Add to `config.yaml`:
```yaml
enableServerPlugins: true
```

Restart SillyTavern.

---

## 🔄 Auto-Updates

VectHarePlus has `auto_update: true` in its manifest. If you installed via `git clone`, SillyTavern will automatically check for and apply updates!

Look for the update notification in the Extensions panel, or manually check with the "Check for Updates" button.

---

## ❓ FAQ

**Why are there two separate pipelines under the hood?**
Internally VectHarePlus routes content through one of two retrieval paths, picked by content type:

| Pipeline | What it handles |
|---|---|
| **EventBase** | Your chat history (live chat + uploaded `.jsonl` archives) |
| **Standard (Chunk)** | Everything else: Lorebook, Character Cards, URLs, documents, wiki pages, YouTube transcripts |

They never see each other's content — so the same chat message can't get retrieved twice (once as an event and once as a raw chunk). You don't normally need to think about this; it just means EventBase owns chat, and the standard chunk pipeline owns everything else.

**Can I change the CJK Tokenizer Mode mid-chat?**
No — don't do it. The CJK Tokenizer Mode is **locked into each Qdrant collection at upsert time** via a sentinel point. Switching modes after you've already vectorized content will trigger a "Tokenizer mismatch" warning modal on the next query, and your only real options are:
1. **Revert** to the original mode (preserve existing vectors), or
2. **Re-vectorize the collection from scratch** with the new mode (throw away all extracted events and start over).

Pick your tokenizer mode *before* you start vectorizing a chat and stick with it. There's no in-place migration — sparse vectors were tokenized with the original mode, so they're incompatible with a different tokenizer's output.  Pick your embedding model *before* you start vectorizing a chat and stick with it.

**Why is EventBase ignoring my temporal decay setting?**
EventBase has its own built-in recency bonus baked into the 4-weight re-ranker. The standalone temporal decay setting only applies to non-chat content (lorebook, documents). This is intentional — applying both would double-decay chat events.

**Can I use triggers/emotion conditions on Chinese/Japanese/Korean chats?**
Not reliably. The keyword dictionary is English-only and regex `\b` word boundaries don't fire between CJK characters. Use "Active for current chat" / Character lock instead, or numeric Message Count / Turn Count conditions.

**Why "scene" settings can't be found?  It was in the original VectHare**
Scene support was removed (it was a chunk-based-chat-era feature, and chat now runs through EventBase). Grouping events together is not quite logical, so the feature was removed.

---

## 🐛 Troubleshooting

**"No embeddings available"** — Enable Vectors extension in main ST settings, select an embedding provider, add API key if needed, run Diagnostics.

**Events/chunks not retrieved** — Click Vectorize to index, lower the score threshold (try 0.3), confirm the collection is "Active for current chat" or has matching triggers.

**"Backend health check failed"** — On Qdrant, make sure the Qdrant server is running and the Similharity plugin is installed.

**Slow performance** — Switch to Qdrant + A3 (single round-trip, server-side fusion). Reduce EventBase Top K. Use API embedding providers (parallel) instead of local GPU (sequential).

**Memory forgetting important details** — Mark important chunks temporally blind, raise the decay floor, add trigger keywords (English content only).

---

## 🙏 Credits

**VectHarePlus** is branched from VectHare, originally created by **Coneja Chibi**. Thanks to the SillyTavern community for feedback and testing.

MIT License — see LICENSE.

---

*"Lets make your memory hardcore!."* 🐰✨
