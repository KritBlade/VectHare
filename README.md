# 🐰 VectFox — Advanced RAG for SillyTavern

> *Persistent memory for long-running roleplay stories*. VectFox delivers LLM-extracted story events, native sparse-vector hybrid search, and scalable performance powered by a real vector database.

![License](https://img.shields.io/badge/license-GPLv3-blue) ![Status](https://img.shields.io/badge/status-Active-brightgreen)

**Languages:** **English** | [繁體中文](README_ZH.md) | [日本語](README_JP.md) | [한국어](README_KR.md)

---

## 🎯 What is VectFox?

Built on the excellent VectHare foundation, VectFox is a **high-performance long-term memory system for SillyTavern**. It goes well beyond a language-extended fork — all intelligent retrieval logic runs server-side inside a real vector database (Qdrant), a structured event-based approach replaces raw chunk summarization for dramatically more accurate recall, and queries return in under 3 seconds even at 2,000+ messages. Natively multilingual: English, Japanese, Korean, Traditional Chinese, and Simplified Chinese.

I branched the original VectHare to handle the massive scale of my personal [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) projects, which feature:
- **Extreme scale: 2,000+ replies per story, with 1,000+ words per reply. Summary retrieval returns in less than 3 seconds**
- Non-English language support (Japanese, Korean, Traditional/Simplified Chinese). It supports English by default.
- Strip out all functional tag from [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker).
- Super long term memory that actually works (2000+ messages)

Ordinary SillyTavern memory extensions completely buckle under this load, especially when there are a lot of functional tags reside inside the story used by [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker), which is useless for memory lookup. So, I need something that is able to clean up all these functional tags while maintain high speed vectorization on extreme scale.

Most memory extensions are designed for chats with 100 messages or fewer, and they work perfectly well at that scale. But as the chat grows past that, they're forced to summarize older messages more and more aggressively. You end up with full detail on recent history and a heavily compressed blur for everything older — and there's no real way around it, because you simply can't fit 100+ messages worth of raw context into the prompt or auto-created lorebook entries. Old memory *has* to be compressed, which means detail is lost.

Cars with square wheels will never solve the problem, no matter how much you fine-tune them. I need the right tool for the job. What I actually need is a dedicated vector database backend to properly store all these memories.

To tackle this, VectFox uses a dedicated vector database that stores **every single meaningful event** from the chat. Whether it's the first message or the 2,000th, every meaningful event stays in the database and is always available for SillyTavern to search.  I want a production grade memory vector system for SillyTavern which is scalable to 10k+ messages and round trip time within seconds.

### The Problem It Solves
- 🧠 **The original VectFox doesn't think about what's worth remembering.** VectFox adds an LLM-driven **EventBase** extraction layer on top: the AI decides which moments are meaningful events and tags each event with the characters, items, locations, and concepts involved.
- 🤖 **The original VectFox doesn't reason about your query** — it only matches surface-level text similarity. VectFox adds optional **Agent Mode** that uses a small LLM to plan multi-angle searches, surfacing memories your raw query wouldn't have found on its own.
- 😩 Strip out all functional tags used by [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) before memory storage.
- 🧠 Adding story-based memory on top of character-based memory in [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker).
- 💸 Long conversations choke your token budget with irrelevant history.
- ✍️ You no longer need to manually edit context to remind characters of key events.
- 🎯 **Garbage in → Garbage out.** Summarizing raw chat into unstructured text blobs and vectorizing them produces noisy, low-signal retrieval. EventBase enforces a **strict structured format** (`characters`, `items`, `locations`, `concepts`, `keywords`, `importance`, `DateTime`) stored natively in the vector DB — not just text chunks. Agent Mode then queries this highly structured data with **targeted structural queries** (filtering by character, concept, location), dramatically increasing hit rate compared to pure text similarity over unstructured summaries.

**VectFox Solution:** Use **Qdrant** as a dedicated vector database that stores every meaningful event from the chat, no matter how long it gets. For users who aren't ready to run an extra service, a **"light" version using the A1 and A2 paths** runs on SillyTavern's built-in vector store with no additional software — it shares many features of the full vector DB at smaller scale. When you're ready for a real long-term memory system, upgrade to the **A3 path** with Qdrant.

Note: Qdrant is free and open source


### What VectFox is NOT trying to solve
VectFox is a **memory** system, not a tracker. It does not track quest progress, character stats, or live world state. For that, pair it with [MVU Game Maker](https://github.com/KritBlade/MVU_Game_Maker) — a character-based tracking system with a built-in GUI for quests, characters, and stats. Running both together covers roughly 90% of the memory and state problems that plague long-form SillyTavern roleplay.


---

## 🧠 How It Works

Vector search is like a really smart "find" function. Instead of matching exact words, it matches **meaning** — type "I'm hungry" and it can find a message that said "let's grab lunch" because the *meaning* is similar.

VectFox is built around two ideas that work together:

### 1. EventBase — events extracted from windows, not summary-per-reply

Most memory extensions take each/several AI replies and summarize it into one blob of text. That sounds fine until you look at what's actually in a reply:

- A 100-sentence reply might contain **5 meaningful events** (a fight, a discovery, a promise, an item swap, a relationship beat) buried in 95 sentences of filler dialogue, scene-setting, and chitchat
- Another reply might contain **zero events** — just banter
- A third might pack **1 event** into 1000 words.

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

Later when you mention "remember the shopping trip?", VectFox retrieves **the event** — not 100 raw sentences, and not a blurry summary that averaged the shopping trip with the unrelated banter that surrounded it.

### 2. Why a dedicated vector DB is the natural fit

If you only do summary-per-reply, you don't really *need* a vector database. You're producing ~1 blob per reply, always the same shape, and you re-summarize them recursively as the chat grows. A simple text file would do — and that's exactly why many older memory extensions never bothered with a real DB.

But once you commit to EventBase, the picture changes:

- 2,000 replies → potentially **1,000–3,000 structured events** (some replies extract several, some extract none)
- Each event has rich fields: characters, locations, items, concepts, keywords, importance, timestamps
- You need to find the relevant 5–10 events by **meaning + keyword + metadata filtering**, in real time, while the user is mid-conversation

That's exactly the workload a **dedicated vector database like Qdrant is designed for**: many small structured records with both dense vector similarity and sparse keyword search, plus metadata filtering, plus global BM25 weighting across the full corpus. Trying to do this with a flat file of summaries would mean linear scans, no keyword indexing, no metadata filters, and no scale beyond a few hundred entries.

EventBase doesn't *force* you onto Qdrant — the A1/A2 light paths run on SillyTavern's built-in Vectra. But once your chat passes a few hundreds events, Qdrant is the storage layer that was actually built for this shape of data.

### 3. Agent Mode — let an AI plan your search (optional, Qdrant / A3 only)

Plain vector search has one weakness: it can only search for what you literally typed. Ask *"do you remember why I paid the ransom?"* and the search looks for events matching those words. But the real answer might involve the kidnapping that led to the ransom, the negotiation where the price was decided, and your character's reaction afterward — and your raw question doesn't mention any of those.

**Agent Mode adds a small "planner" LLM** that reads your recent chat plus the top semantic matches, then asks: *"What other angles should I search for to really answer this?"* It outputs 1–4 follow-up queries that fan out in parallel against Qdrant.

**Concrete example.** You type:
> *I say to Mayla, "Do you remember why I paid your ransom back then?"*

Without Agent Mode the search finds:
- ✓ The ransom payment event itself (direct keyword match on "ransom")

With Agent Mode the planner adds these angles automatically (illustrative planner output for this kind of query):

```json
{
  "queries": [
    "Critblade ransom Mayla reason",
    "Mayla past fear of abandonment",
    "Critblade promise to help find her father",
    "Mayla leadership challenge moment"
  ],
  "filters": {
    "characters_any": ["Critblade", "Mayla"],
    "concepts_any": ["ransom", "abandonment", "leadership"]
  }
}
```

Four parallel Qdrant searches return:
- ✓ The ransom payment (direct)
- ✓ Mayla's past fear of abandonment (emotional context)
- ✓ The promise to find her missing father (a related narrative beat the planner inferred from recent chat context)
- ✓ The leadership-challenge moment (a related arc the planner pulled in)

All four merge with the original search and feed the same 4-weight re-ranker. The main reply LLM then has the **full causal chain plus emotional context** instead of just the moment of payment.

**Why Agent Mode pairs with A3 (Qdrant)**:
- Each planner query is a separate Qdrant call. Qdrant fanout completes in 1–3 seconds for 4 parallel queries.
- A1/A2 (Vectra) would serialize these and lose the parallelism advantage.
- Qdrant's payload filters (`characters_any`, `concepts_any`) let the planner narrow each search precisely — the standard backend doesn't expose these.

**Cost & latency**: ~$0.0002 with GPT-4o-mini or Haiku as the planner, ~2–5 seconds added per turn. It's purely additive — never replaces normal search, and falls back cleanly to the standard flow if the planner fails. Configure it in the dedicated **AgentMode** tab; default off.

> 💡 Agent Mode works best on **reflective questions** ("why...", "remember when..."), **vague callbacks** ("that thing about my father"), and **cause-chain queries** where the literal user message doesn't contain the search anchors. For direct lookups where your message already contains the right keywords, the standard pre-search already does most of the work; Agent Mode is incremental polish.

### 🧠 Why this beats traditional memory extensions

Most existing memory extensions use one of two approaches. Both lose detail as the chat grows. Here's why — and how EventBase avoids it:

| Aspect | 📝 Rolling Summary <br>*(most "memory" extensions)* | ✂️ Raw Chunking <br>*(older vector RAG)* | 🧬 EventBase <br>*(VectFox)* |
|---|---|---|---|
| **What gets stored** | One ever-growing summary text | Every message cut into raw chunks | Structured event records with metadata |
| **At msg 100** | Mostly intact | Intact | Intact |
| **At msg 200** | Heavily compressed — names, numbers, and one-off details drift or vanish | Token budget overflow — older chunks score-pruned or dropped | **Intact** — old events still in DB, surfaced by relevance |
| **At msg 1,000+** | Effectively a blur | DB bloat; retrieval gets noisy because raw chunks are low signal | **Intact** — only the few events relevant to the current scene are pulled |
| **What "compression" does** | Re-summarizes the summary recursively, so every pass loses information | None — but no synthesis either; raw text is hit-or-miss for retrieval | One-time, semantic — extracts *the meaningful event* and drops filler. Detail in the event itself is preserved. |
| **Retrieval signal** | None — the whole summary is always injected | Vector similarity over raw text (catches paraphrases but also noise) | Vector + BM25 hybrid over rich fields (`characters`, `items`, `locations`, `concepts`, `keywords`, plus dense meaning) |
| **Where detail goes** | Lost forever once compressed | Lost when chunk drops below score threshold | **Doesn't go anywhere** — events live in the vector DB and surface when relevant |
| **What gets injected** | The whole running summary (every turn, every time) | A few semantically-close raw messages | Only the events that matter for the current message |

**The core insight:** rolling summaries lose detail because they *throw away* old content to make room. Raw chunking loses detail because *retrieval breaks* at scale. EventBase keeps every meaningful event around forever — and lets vector + keyword search decide which 5–10 of them are worth showing the AI right now. Detail isn't compressed; **irrelevance is filtered**.

> 💡 **The way you phrase your message has a big impact on what gets retrieved.** Because retrieval is driven by the text of your reply, the words you use matter. For example, *"Mayla, Do you remember why I paid the ransom?"* and *"Mayla, Do you remember why I paid 2,000 bucks?"* will return very different events — "ransom" pulls in every event tied to that storyline (the kidnapping, the negotiation, the drop-off), while "2,000 bucks" mostly matches events that literally mention the number 2,000. If you want the AI to recall a specific scene, anchor your message with the **story-meaningful words** from that scene rather than incidental details like exact numbers.  Having said that, I did the testing and A3 Path still manage to find the ransom event in 1500+ events in the DB on both replies while A1 and A2 Path (See Path explaination below) failed on the 2nd input.  The first reply with correct anchor wording defintely get better quality of retrieval result for A3 Path though.

---

## 🔍 Hybrid Search: A1 vs A2 vs A3 Path

VectFox combines **two signals** to find the best results:

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

### A3 — Qdrant native sparse + server-side RRF + formula rerank (best accuracy)
Both searches run **inside Qdrant vector database in a single API call** — but A3 goes well beyond just hybrid search. The entire memory-ranking pipeline moves server-side in the same request:

1. **Dense + sparse hybrid** — Qdrant searches its dense index (meaning) and sparse index (keywords) simultaneously against the **full corpus**, fuses via native RRF. BM25 IDF is computed globally across every event in the database, not just a top-K sample, so rare words score correctly.

2. **Server-side formula rerank** — Qdrant then applies the 4-weight importance/persist/recency formula to those hybrid results inside the same call: `cosine × RRF score + importance weight + persistence bonus + recency decay`. The final ranked list comes back already sorted. No extra round-trip. No browser JavaScript doing the scoring.

3. **Server-side filtering** — Minimum importance threshold and context dedup cutoff (events already visible in recent chat) are enforced inside Qdrant, not after the results arrive. Events below the threshold never leave the server.

4. **AgentMode semantic pre-filtering + multi-angle querying** — AgentMode does two things that compound each other. First, the planner LLM decomposes the user's question into multiple sub-queries from different angles — not just the surface meaning, but also *how did this happen?*, *what led up to it?*, *what were the consequences?*, *who else was involved?* Each angle runs as a separate vector search. Second, the planner emits structured entity filters (`characters_any`, `locations_any`, `factions_any`, `concepts_any`, `event_type_any`, `importance_gte`) applied as Qdrant payload clauses in the same call, narrowing the candidate pool *before* vector search even runs. The combination is powerful: multi-angle queries cast a wide semantic net while pinpoint filters ensure every search stays scoped to the right entities — irrelevant characters, locations, or event types never compete for recall slots.

The browser only handles anchor boost (phrase matching), pairwise dedup, and the final merge across multiple collections.

**Example:** Searching "I cast Fireball at the dragon." Qdrant searches dense (spell/attack meanings) and sparse (literal "Fireball" + "dragon") at the same time, fuses via RRF, ranks by importance/recency formula, filters low-importance events — and returns the final ready-to-inject list in one call.

**AgentMode example:** Asking "What deal did we make with Shadowheart?" The planner emits `characters_any: ["Shadowheart"]` and fans out into sub-queries: the original question, *"what agreement or promise involving Shadowheart"*, *"what event led to the deal with Shadowheart"*, *"what did Shadowheart ask for in return"*. Each sub-query runs against a Qdrant candidate pool already restricted to Shadowheart-tagged events — broad semantic recall, zero cross-character noise.

**Tradeoff:** Best accuracy, fastest at scale. Requires a Qdrant instance (free, open-source). → [Qdrant installation guide](Doc/Qdrant_install.md)

| What runs where | A1 — Standard + BM25 | A2 — Standard + Hybrid | A3 — Qdrant Native |
|---|---|---|---|
| Requires Qdrant | ❌ No | ❌ No | ✅ Yes (free, open-source) |
| BM25 keyword scope | Top ~100 vector results only | Top ~300 vector results only | **Full corpus** (globally accurate IDF) |
| Dense + sparse fusion | Weighted blend, browser | RRF + dual-signal bonus, browser | **Server-side RRF, 1 call** |
| Importance / recency re-ranking | Browser JS | Browser JS | **Server-side formula** (Qdrant ≥ 1.13) |
| Minimum importance filter | Browser JS | Browser JS | **Server-side** |
| Context dedup filter | Browser JS | Browser JS | **Server-side** |
| AgentMode semantic pre-filtering | ❌ Not supported | ❌ Not supported | **Server-side** (characters, locations, factions, concepts, event type) |
| Network calls per query | 1 | 1 | **1** (hybrid + rerank + filter, all in one) |
| Scale ceiling | ~500 events | ~500 events | **10,000+ events** |

| Backend setting | Path you get |
|---|---|
| Standard (Vectra - standard SillyTavern vector format) + BM25 | A1 |
| Standard (Vectra - standard SillyTavern vector format) + Hybrid | A2 |
| Qdrant (dedicated vector DB) | A3 |

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

### 🤖 Agent Mode — LLM-planned multi-angle retrieval (Qdrant / A3 only)
A small planner LLM reads your recent chat plus the top pre-search candidates, then emits 1–4 follow-up Qdrant queries each targeting a different angle of what you asked about. Results fan out in parallel and merge through the same 4-weight re-ranker — purely additive, never replaces normal search. Falls back cleanly to the standard flow on any failure. Best for **reflective questions, vague callbacks, and cause-chain queries** where the literal user message doesn't contain the right search anchors.

- **Provider/model inheritance** — leave blank in AgentMode tab to inherit from your summarizer config; override with a cheaper model (e.g. Haiku 4.5, GPT-4o-mini) to cut planner cost.
- **Language-matching prompt** — planner emits queries in the chat language (Chinese, Japanese, Korean, Latin-script, English), preserving proper nouns. No cross-language pollution.
- **Configurable sliders** — past chat turns sent to planner (1–10), candidates shown to planner (5–20), max queries (1–4), timeout (1–60s), debug logging.
- **Real cost** — ~$0.0002 per turn with a small fast model, ~2–5 seconds added latency. Disabled by default — opt in when long-form recall matters.

See the **AgentMode** tab in settings, or the "How It Works → Agent Mode" section above for the full architecture.

### 🌏 CJK language support (Japanese, Korean, Traditional/Simplified Chinese)
- Jieba WASM (Simplified + Traditional Chinese), TinySegmenter (Japanese), Intl.Segmenter (English/Latin/Korean)
- **Dedicated stop-word lists per language** — separate curated dictionaries for Japanese, Korean, Traditional Chinese, and Simplified Chinese (plus English/Latin). Stop words are the filler grammar particles like 「の・は・を」 in Japanese, 「的・地・得」 in Chinese, and 「의・은・는・을」 in Korean that show up everywhere but carry zero search signal. Stripping them before keyword scoring is what keeps BM25 hit-rates high on CJK content — without it, every event would "match" your query just because it contains common particles, drowning out the actual signal words.
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

> ⚠️ **Legacy feature note:** Triggers and condition-based activation are **inherited from VectHare** and kept here for backward compatibility only. Due to major architectural changes in VectFox, **users should always make collections "Active for current chat" or use Character lock** instead of relying on triggers/conditions. The whole point of vector search is to let the search engine search everything — selective activation based on keyword triggers defeats that purpose.
> 
> **CJK note:** Triggers and emotion/keyword conditions are also **English-only** — the keyword dictionary is English and regex `\b` word boundaries don't fire between CJK characters. For Chinese/Japanese/Korean stories, use **"Active for current chat" / Character lock** instead. Message Count / Turn Count conditions are numeric and work fine for any language.

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
   https://github.com/KritBlade/VectFox
   ```
5. Click **Install**

That's it! VectFox will be downloaded and enabled automatically.

### Step 2: Configure VectFox
1. Open **VectFox Settings** (Core tab in the extensions panel).
2. Choose your vector storage (Standard or Qdrant).
3. Select your embedding provider (Transformers, vLLM, Ollama, OpenRouter, etc.).
   - 💡 **Recommended:** use `qwen/qwen3-embedding-8b` through **OpenRouter**. It's extremely cheap ($0.00000015/run), multilingual (excellent CJK + Latin), and produces high-quality dense vectors for the corpus size VectFox targets.
4. Select your Summarization LLM (OpenRouter or vLLM) — used by EventBase extraction during vectorization.
   - 💡 **Recommended cheap & fast models:** `openai/gpt-4o-mini` or `x-ai/grok-4.1-fast` ($0.0004/run) through OpenRouter. Both are very cheap and fast enough to keep ingestion latency low. Same recommendation applies to the **Agent Mode LLM** (configured separately in the AgentMode tab) — if you leave the AgentMode model field blank it inherits this summarizer setting.
5. Configure API keys if using cloud providers (OpenRouter / vLLM / OpenAI / Cohere).
6. Under **Keyword Extraction**, choose the language of your story.
7. Most settings work fine on default — feel free to tweak.
8. Open your chat in SillyTavern, then click the VectFox extension icon again. You **HAVE** to click "Vectorize Content" and choose **Chat History** to vectorize your first DB.
9. Enable Auto-Sync if needed in the **AutoSync** tab. Frequency is controlled by the EventBase tab under *Extraction > Window Size*.
10. Vectorize your lorebook / World Info if needed in the **WorldInfo** tab.
11. (Optional) Turn on **Agent Mode** in the AgentMode tab once everything else works. Leave provider/model/API-key blank to inherit from your summarizer config — that way the same cheap/fast model used in step 4 also drives the planner. See "How It Works → Agent Mode" above for what it does.

### Step 3: (Needed for Qdrant backends ONLY) Install Similharity Plugin

```bash
Open Command prompt on Windows or Terminal on Linux/Mac or Get into Console if you are on docker
cd SillyTavern/plugins
git clone -b Similharity-Plugin https://github.com/KritBlade/VectFox.git similharity
cd similharity
npm install
```

Search the following key in `config.yaml` and change to true:  (Windows will be at SillyTavern\config.yaml while linux/Mac should be at SillyTavern\config\config.yaml)
```yaml
enableServerPlugins: true
```

Restart SillyTavern.

---

## 🔄 Auto-Updates

VectFox has `auto_update: true` in its manifest. If you installed via `git clone`, SillyTavern will automatically check for and apply updates!

Look for the update notification in the Extensions panel, or manually check with the "Check for Updates" button.

Setting enableServerPlugin to true is required for Qdrant backend.

---

## ❓ FAQ

**Why are there two separate pipelines under the hood?**
Internally VectFox routes content through one of two retrieval paths, picked by content type:

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

**How do I delete a collection safely?**
**ALWAYS use the Database Browser inside VectFox** (Action tab → "Database Browser" button) to delete collections. Click the red "Delete" button on the collection card. This properly cleans up both the vector database **and** VectFox's internal registry + metadata. Never delete collections manually from Qdrant's web UI or by editing SillyTavern's `settings.json` — doing so leaves orphaned metadata that causes sync conflicts, "collection not found" errors, and other strange behavior.

**Why "scene" settings can't be found?  It was in the original VectHare**
Scene support was removed (it was a chunk-based-chat-era feature, and chat now runs through EventBase). Grouping events together is not quite logical, so the feature was removed.

---

## 🐛 Troubleshooting

**"No embeddings available"** — Enable Vectors extension in main ST settings, select an embedding provider, add API key if needed, run Diagnostics.

**Events/chunks not retrieved** — Click Vectorize to index, lower the score threshold (try 0.3), confirm the collection is "Active for current chat" or has matching triggers.

**"What would the AI actually recall for this message?"** — Use the **Debug Query** button in the Actions tab for "what-if" testing. Type any text and run it against the live database to see exactly which events would be retrieved and their scores, without sending a real chat message. Useful for tuning thresholds and verifying that important events are indexed correctly.

**"Backend health check failed"** — On Qdrant, make sure the Qdrant server is running and the Similharity plugin is installed.

**Slow performance** — Switch to Qdrant + A3 (single round-trip, server-side fusion). Reduce EventBase Top K. Use API embedding providers (parallel) instead of local GPU (sequential).

**Memory forgetting important details** — Mark important chunks temporally blind, raise the decay floor, add trigger keywords (English content only).

---

## 🙏 Credits

**VectFox** is branched from VectHare, originally created by **Coneja Chibi**. Thanks to the SillyTavern community for feedback and testing.

GPLv3 License — see LICENSE.

---

*"Lets make your memory hardcore!."* 🐰✨
