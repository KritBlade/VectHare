# 🐰 VectHarePlus - Advanced RAG for SillyTavern

> *It's like having a perfect memory for your roleplay conversations.* VectHarePlus brings intelligent context retrieval to SillyTavern with temporal decay, conditional activation, and multiple vector backends.

![Version](https://img.shields.io/badge/version-2.0.0--alpha-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Status](https://img.shields.io/badge/status-Active-brightgreen)

---

## 🎯 What is VectHarePlus?
Branched from the original VectHare project, VectHarePlus is an **advanced Retrieval-Augmented Generation (RAG) system** for SillyTavern, now featuring newly added, optimized support for Japanese, Traditional Chinese, and Simplified Chinese.

I branched the original VectHare to handle the massive scale of my personal MVU Game Maker projects, which feature:
- Non-English language support (Japanese, Traditional/Simplified Chinese).  It supports English by default.
- Extreme scale: 2,000+ replies per story, with 1,000+ words per reply.
- Strip out all functional tag from MVU Game Maker.

Ordinary SillyTavern memory extensions completely buckle under this load, especially when there are a lot of functional tags reside inside the story used by MVU Game Maker, which is useless for memory lookup.  So, I need something that is able to clean up all these functional tags while maintain high speed vectorization on extreme scale.

Technical Requirement: Because of the high data throughput required, this system relies on a separate Qdrant vector database running via Docker.

### The Problem It Solves

- 😩 Strip out all functional tags used by MVU Game Maker before memory storage.
- 🧠 Adding story based memory on top of character based memory in MVU Game Maker.
- 💸 Long conversations choke your token budget with irrelevant history
- ✍️ You manually edit context to remind characters of key events

**VectHarePlus Solution:** Automatically extract relevant memories from your entire chat history using semantic search, with smart temporal decay that lets older memories fade naturally, and conditional rules to control exactly when memories activate.

---

## ➕ VectHarePlus Features

### 🌏 Better CJK Language Support
- **Japanese mode** with TinySegmenter-aware extraction behavior
- **Traditional Chinese mode** with Jieba WASM + Traditional dictionary lazy loading
- **Simplified Chinese mode** with Jieba WASM support
- Language-aware keyword filtering with cleaner CJK token handling

### 📝 Summarize Before Store
- Optional summarization before vector storage to reduce noise and improve retrieval density
- Supports OpenRouter and local vLLM-compatible endpoints
- Configurable prompt template so you can tune summary style for your RP format

### ⏯️ Better Vectorization Controls
- **Stop button** in progress flow to halt long-running vectorization tasks
- **Pause/continue style control** for vector content processing workflows
- Improved control over long chat ingestion sessions without restarting everything

### 🧹 Keyword Quality Improvements
- Better single-character filtering defaults for CJK keywords
- Mode-specific exceptions for high-signal 1-character RPG/SoL/school terms
- Better signal-to-noise for multilingual retrieval

### 🧹 Numerous bug fixes

---

## ✨ Key Features

### 🧠 Intelligent Context Retrieval
- **Semantic search** through your entire chat history
- Find relevant messages even from hundreds of messages ago
- Replace manual memory management with automatic retrieval
- Works with any embedding model (local or cloud-based)

### ⏰ Temporal Decay System
- **Memories naturally fade** over time, just like humans
- Exponential or linear decay modes
- Set custom half-life for how quickly memories decay
- Protect important scenes from fading (temporally blind)
- Optional feature—disable if you want permanent memory

### 🎭 Conditional Activation Rules
- Activate memory chunks based on **character emotions** (happy, sad, angry, etc.)
- Trigger on **conversation topics** or keywords
- Smart recency checks (activate only for recent events)
- Character Expressions integration for sprite-based emotion detection
- Fallback to keyword-based emotions if no expressions extension

### 🎬 Scene Management
- **Mark scenes** in your chat to group related messages
- Scene chunks are treated as single units for retrieval
- Perfect for story arcs, major events, or important character moments

### 📦 Multiple Vector Backends
- **Standard (Vectra)**: ST's built-in file-based storage (great for getting started)
- **LanceDB**: Disk-based, handles millions of vectors, production-ready
- **Milvus**: Legacy backend option kept for compatibility workflows
- **Qdrant**: Enterprise-grade with HNSW indexing, cloud support, advanced filtering

> ⚠️ **VectHarePlus backend status:** Only **Qdrant** is actively tested in VectHarePlus. **Vectra, LanceDB, and Milvus** are kept for backward compatibility with VectorHare and are not guaranteed to work in every setup.

### 📄 Multi-Content Vectorization
- Chat conversations (with automatic chunking strategies)
- Lorebook entries (preserve structure with per-entry chunks)
- Character definitions and personality
- Custom content types

### 🔍 Advanced Chunking Strategies
- **Per Message**: Each message = one chunk (best for chat recall)
- **Conversation Turns**: Group by speaker turns
- **Message Batch**: Process in configurable batches
- **Per Scene**: Scene-marked groups become chunks

### 🗃️ Database Browser
- Browse all vector collections (chat, lorebook, character)
- View chunk counts and metadata
- Enable/disable collections on the fly
- Export and import collections for backup/sharing

### 🔎 Chunk Visualizer
- View all chunks in a collection
- Edit chunk text and metadata
- Mark chunks as temporally blind (immune to decay)
- Search and filter chunks

### 🚨 Comprehensive Diagnostics
Built-in diagnostic tool that checks everything and offers auto-fixes for common issues.

---

## 🚀 How It Works

### The RAG Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│  1. VECTORIZATION                                           │
│  ─────────────────                                          │
│  Chat messages are chunked and embedded into vectors        │
│  Each chunk stores: text, metadata, keywords, source        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  2. SEARCH & RETRIEVAL                                      │
│  ──────────────────────                                     │
│  When generating a response, recent messages are queried    │
│  against the vector database to find semantically similar   │
│  chunks from your chat history                              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  3. FILTERING & SCORING                                     │
│  ─────────────────────                                      │
│  • Apply temporal decay (older = lower score)               │
│  • Evaluate conditional activation rules                    │
│  • Boost by keywords                                        │
│  • Re-rank by relevance                                     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  4. CONTEXT INJECTION                                       │
│  ───────────────────                                        │
│  Top-scoring chunks are formatted and injected into the     │
│  prompt before generation                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🗄️ Backend Comparison

| Backend | Best For | Pros | Cons |
|---------|----------|------|------|
| **Standard (Vectra)** | Legacy compatibility / small datasets | No dependencies, works out of box | Legacy compatibility path in VectHarePlus; behavior not guaranteed |
| **LanceDB** | Legacy compatibility / medium datasets | Fast local vector DB | Legacy compatibility path in VectHarePlus; behavior not guaranteed |
| **Milvus** | Legacy compatibility / existing deployments | Familiar ecosystem for older setups | Legacy compatibility path in VectHarePlus; behavior not guaranteed |
| **Qdrant** | Production, cloud deployments | Enterprise-grade, advanced filtering | Requires running Qdrant server |

> 💡 **Need help choosing?** Use **Qdrant** for VectHarePlus if you want the tested path.

---

## ⏳ Temporal Decay System

Memories don't stick around forever. VectHarePlus implements intelligent temporal decay that makes memories naturally fade over time.

### How It Works

**Exponential Decay** (default):
```
relevance = original_score × (0.5 ^ (message_age / half_life))
```

For example, with half-life = 50:
| Messages Ago | Relevance |
|--------------|-----------|
| 0 | 100% |
| 50 | 50% |
| 100 | 25% |
| 150 | 12.5% |

### Configuration Options
- **Enabled**: Toggle decay on/off (default: OFF)
- **Mode**: Exponential or Linear
- **Half-life**: Messages until 50% relevance (default: 50)
- **Floor**: Minimum relevance, prevents complete forgetting (default: 0.3)
- **Temporally Blind**: Mark important chunks to be immune to decay

> 💡 **Pro Tip:** Set a high floor (0.5+) to keep important memories accessible even when old. Mark character introductions as temporally blind!

---

## 🎭 Conditional Activation Rules

Control precisely **when** chunks activate using intelligent rules.

### Rule Types

| Type | Description | Example |
|------|-------------|---------|
| 🎬 **Emotion** | Activate when character feels specific emotion | Activate sad memories when character is sad |
| 🔑 **Keyword** | Activate when keywords appear in chat | Activate "treasure" memories when discussing treasure |
| 📍 **Recency** | Activate only for recent messages | Only use memories from last 10 messages |
| 🎯 **Combined** | Mix multiple conditions with AND/OR | Emotion=happy AND keyword contains "party" |

Supports 28 emotion types with Character Expressions integration!

---

## 💾 Installation

### Step 1: Install the Extension

1. Open SillyTavern in your browser
2. Go to **Extensions** panel (puzzle piece icon)
3. Click **"Install Extension"**
4. Paste this URL:
   ```
   https://github.com/Coneja-Chibi/VectHare
   ```
5. Click **Install**

That's it! VectHarePlus will be downloaded and enabled automatically.

### Step 2: Configure Embedding Provider
1. Open **VectHarePlus Settings** (🐰 icon in the extensions panel)
2. Select your embedding provider (Transformers, OpenAI, Ollama, BananaBread, etc.)
3. Configure API keys if using cloud providers

### Step 3: (Optional) Install Similharity Plugin

**Only needed for LanceDB or Qdrant backends!**

```bash
cd SillyTavern/plugins
git clone -b Similharity-Plugin https://github.com/kritblade/VectHare.git similharity
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

## ⚙️ Settings Overview

### 🎛️ Core Settings
| Setting | Description |
|---------|-------------|
| **Vector Backend** | Standard, LanceDB, or Qdrant |
| **Embedding Provider** | 15+ providers supported |
| **API URL** | Custom endpoint for local providers |

### 💬 Chat Vectorization
| Setting | Description |
|---------|-------------|
| **Enable Auto-Sync** | Automatically vectorize new messages |
| **Chunking Strategy** | Per Message, Conversation Turns, Message Batch, Per Scene |
| **Score Threshold** | Minimum similarity to include chunk (0.0-1.0) |
| **Query Depth** | How many chunks to retrieve |
| **Insert Count** | How many chunks to inject into prompt |

### ⏰ Temporal Decay
| Setting | Description |
|---------|-------------|
| **Enabled** | Toggle decay system |
| **Mode** | Exponential or Linear |
| **Half-life** | Messages until 50% relevance |
| **Floor** | Minimum relevance multiplier |

---

## 🎯 Pro Tips & Best Practices

### 🧠 Memory Quality
- **Per Message chunks work best** for dialogue-heavy chats
- **Mark scenes for major events** to keep them cohesive
- **Set temporally blind on character intros** so your AI never forgets who people are

### 🚀 Performance
- **Start with Standard backend** - upgrade to LanceDB when needed
- **Large chats (10k+ messages)?** LanceDB handles it smoothly
- **Lower score threshold** if memories aren't being retrieved (try 0.3)

### 🎭 Conditional Activation
- **Pair emotions with Character Expressions** for sprite-based detection
- **Add topic keywords** to make memories context-aware
- **Use recency rules** for time-sensitive information

### 💾 Data Management
- **Export collections regularly** as backups
- **Run diagnostics** if something feels off
- **Check the Database Browser** to see what's actually stored

---

## 🐛 Troubleshooting

### "No embeddings available"
1. Enable Vectors extension in main ST settings
2. Select embedding provider in VectHarePlus settings
3. Add API key if using cloud provider
4. Run Diagnostics to verify connectivity

### Chunks not being retrieved
1. Click "Vectorize" button to index current chat
2. Lower score threshold (try 0.3)
3. Check Chunk Visualizer to verify chunks exist
4. Run Diagnostics for detailed health check

### "Backend health check failed"
1. Run Diagnostics to see which backend failed
2. **LanceDB**: Ensure Similharity plugin is installed
3. **Qdrant**: Ensure Qdrant server is running
4. **Fallback**: Switch to Standard backend

### Slow performance
1. Switch to LanceDB backend for large datasets
2. Increase chunk size (fewer, larger chunks)
3. Reduce query depth and insert count

### Memory forgetting important details
1. Mark important chunks as **temporally blind**
2. Increase the decay floor value
3. Lower score threshold
4. Add conditional activation rules for topic-specific recall

---

## 📖 Documentation

Detailed docs available in the `/docs` folder:
- `ARCHITECTURE.md` - System design
- `PLUGGABLE_BACKENDS.md` - Backend implementation
- `METADATA_ARCHITECTURE.md` - Chunk metadata system
- `TEMPORAL_DECAY.md` - Decay formulas and tuning

---

## 🔗 Requirements

### Required
- **SillyTavern** (latest version)
- **Embedding Provider** (one of 15+ supported)

### Optional
- **Similharity Plugin** - For LanceDB/Qdrant backends
- **Character Expressions** - For sprite-based emotion detection

---

## 🤝 Contributing

Found a bug? Have an idea? Contributions welcome!

- 🐛 **Issues**: Report bugs on GitHub
- 💡 **Features**: Open a discussion first
- 🔧 **PRs**: Follow the code standards in `CLAUDE.md`

---

## 📜 License

MIT License - See LICENSE file for details.

---

## 🙏 Credits

**VectHarePlus** is branched from VectHare which is created by **Coneja Chibi** 
Special thanks to the SillyTavern community for feedback and testing!

---

## 🌟 Support

If VectHarePlus helps your roleplay:
- ⭐ Star the repo on GitHub
- 💬 Share your experience
- 🐛 Report bugs to help improve it
- 📚 Contribute docs or examples

---

*"It's like having a memory that actually works."* 🐰✨
