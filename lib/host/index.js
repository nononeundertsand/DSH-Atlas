// src/shared/protocol.ts
var ATLAS_BASE = "/ext/atlas";
var ROUTES = {
  bootstrap: `${ATLAS_BASE}/bootstrap`,
  update: `${ATLAS_BASE}/update`,
  workspaces: `${ATLAS_BASE}/workspaces`,
  workspace: (id) => `${ATLAS_BASE}/workspaces/${id}`,
  viewport: (id) => `${ATLAS_BASE}/workspaces/${id}/viewport`,
  nodes: `${ATLAS_BASE}/nodes`,
  node: (id) => `${ATLAS_BASE}/nodes/${id}`,
  closeNode: (id) => `${ATLAS_BASE}/nodes/${id}/close`,
  visitNode: (id) => `${ATLAS_BASE}/nodes/${id}/visit`,
  threads: `${ATLAS_BASE}/threads`,
  thread: (id) => `${ATLAS_BASE}/threads/${id}`,
  turn: (id) => `${ATLAS_BASE}/threads/${id}/turn`,
  promote: (id) => `${ATLAS_BASE}/threads/${id}/promote`,
  explain: (id) => `${ATLAS_BASE}/threads/${id}/explain`,
  search: `${ATLAS_BASE}/search`
};
var DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };
var LIMITS = {
  recentTurns: 12,
  maxMessageChars: 32e3,
  maxNodes: 500,
  maxMessagesPerThread: 2e3
};

// src/host/store.ts
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
var SAFE_ID = /^[A-Za-z0-9_-]+$/;
var NODE_W = 288;
var NODE_H = 104;
var AtlasStore = class {
  root;
  writeQueue = Promise.resolve();
  constructor(dataDir) {
    this.root = dataDir ?? dshHomePath("atlas");
  }
  get location() {
    return this.root;
  }
  // ── 工作区 ────────────────────────────────────────────────────────────────
  async listWorkspaces() {
    await mkdir(this.workspacesRoot(), { recursive: true });
    const entries = await readdir(this.workspacesRoot(), { withFileTypes: true });
    const workspaces = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const workspace = await this.readJson(this.workspaceFile(entry.name));
      if (workspace) workspaces.push(workspace);
    }
    return workspaces.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async ensureWorkspace() {
    const workspaces = await this.listWorkspaces();
    const active = workspaces.find((item) => item.active) ?? workspaces[0];
    if (active) {
      if (!active.active) await this.setActive(active.id);
      return active;
    }
    return this.createWorkspace("\u6211\u7684\u5730\u56FE");
  }
  async createWorkspace(name, goal) {
    return this.mutate(async () => {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const workspace = {
        id: `w_${shortId()}`,
        name: name.trim() || "\u672A\u547D\u540D\u5730\u56FE",
        goal: goal?.trim() || void 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        rev: 1
      };
      for (const other of await this.listWorkspaces()) {
        if (other.active) {
          await this.writeJson(this.workspaceFile(other.id), { ...other, active: false, rev: other.rev + 1 });
        }
      }
      await mkdir(this.workspaceDir(workspace.id), { recursive: true });
      await this.writeJson(this.workspaceFile(workspace.id), workspace);
      await this.writeJson(this.nodesFile(workspace.id), []);
      await this.writeJson(this.threadsFile(workspace.id), []);
      await this.writeJson(this.viewportFile(workspace.id), { ...DEFAULT_VIEWPORT });
      return workspace;
    });
  }
  async setActive(workspaceId) {
    return this.mutate(async () => {
      const target = await this.requireWorkspace(workspaceId);
      for (const other of await this.listWorkspaces()) {
        const active = other.id === workspaceId;
        if (other.active !== active) {
          await this.writeJson(this.workspaceFile(other.id), {
            ...other,
            active,
            rev: other.rev + 1,
            updatedAt: active ? (/* @__PURE__ */ new Date()).toISOString() : other.updatedAt
          });
        }
      }
      return { ...target, active: true };
    });
  }
  async updateWorkspace(workspaceId, patch) {
    return this.mutate(async () => {
      const workspace = await this.requireWorkspace(workspaceId);
      const next = {
        ...workspace,
        name: patch.name?.trim() || workspace.name,
        goal: patch.goal?.trim() || workspace.goal,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        rev: workspace.rev + 1
      };
      await this.writeJson(this.workspaceFile(workspaceId), next);
      return next;
    });
  }
  async snapshot(workspaceId) {
    const workspace = await this.requireWorkspace(workspaceId);
    const [nodes, threads, viewport] = await Promise.all([
      this.readJson(this.nodesFile(workspaceId)),
      this.readJson(this.threadsFile(workspaceId)),
      this.readJson(this.viewportFile(workspaceId))
    ]);
    return {
      workspace,
      nodes: nodes ?? [],
      threads: (threads ?? []).filter((thread) => thread.kind === "main"),
      viewport: viewport ?? { ...DEFAULT_VIEWPORT },
      rev: workspace.rev
    };
  }
  async saveViewport(workspaceId, viewport) {
    return this.mutate(async () => {
      await this.requireWorkspace(workspaceId);
      const safe = {
        x: finite(viewport.x, 0),
        y: finite(viewport.y, 0),
        zoom: clamp(finite(viewport.zoom, 1), 0.15, 2.5)
      };
      await this.writeJson(this.viewportFile(workspaceId), safe);
      return safe;
    });
  }
  // ── 节点 ──────────────────────────────────────────────────────────────────
  async createNode(input) {
    return this.mutate(async () => {
      const snapshot = await this.snapshot(input.workspaceId);
      if (snapshot.nodes.length >= 500) throw new Error("E_BUDGET: \u8282\u70B9\u6570\u91CF\u5DF2\u8FBE\u4E0A\u9650");
      const parent = input.parentId ? snapshot.nodes.find((node2) => node2.id === input.parentId) : void 0;
      if (input.parentId && !parent) throw new Error("E_NOT_FOUND: \u7236\u8282\u70B9\u4E0D\u5B58\u5728");
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const nodeId = `n_${shortId()}`;
      const threadId = `t_${shortId()}`;
      const siblings = snapshot.nodes.filter((node2) => node2.parentId === (input.parentId ?? null));
      const position = input.position ?? defaultPosition(parent, siblings.length);
      const node = {
        id: nodeId,
        workspaceId: input.workspaceId,
        parentId: parent?.id ?? null,
        title: input.title.trim() || "\u672A\u547D\u540D\u8282\u70B9",
        subtitle: input.subtitle?.trim() || void 0,
        kind: parent ? "topic" : "module",
        status: "seed",
        mastery: 0,
        position,
        threadId,
        createdAt: now,
        updatedAt: now
      };
      const thread = {
        id: threadId,
        nodeId,
        parentThreadId: null,
        kind: "main",
        title: node.title,
        order: 0,
        collapsed: false,
        createdAt: now
      };
      await this.writeJson(this.nodesFile(input.workspaceId), [...snapshot.nodes, node]);
      const threads = await this.readJson(this.threadsFile(input.workspaceId)) ?? [];
      await this.writeJson(this.threadsFile(input.workspaceId), [...threads, thread]);
      await this.touch(input.workspaceId);
      return { node, thread };
    });
  }
  async updateNode(nodeId, patch) {
    return this.mutate(async () => {
      const { workspaceId, nodes, node } = await this.findNode(nodeId);
      const next = {
        ...node,
        ...patch,
        title: patch.title?.trim() || node.title,
        subtitle: patch.subtitle?.trim() ?? node.subtitle,
        mastery: patch.mastery === void 0 ? node.mastery : clamp(Math.round(patch.mastery), 0, 5),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.writeJson(this.nodesFile(workspaceId), nodes.map((item) => item.id === nodeId ? next : item));
      await this.touch(workspaceId);
      return next;
    });
  }
  async deleteNode(nodeId) {
    return this.mutate(async () => {
      const { workspaceId, nodes } = await this.findNode(nodeId);
      const doomed = descendantsOf(nodeId, nodes);
      const doomedSet = new Set(doomed);
      const threads = await this.readJson(this.threadsFile(workspaceId)) ?? [];
      const doomedThreads = threads.filter((thread) => doomedSet.has(thread.nodeId));
      await this.writeJson(this.nodesFile(workspaceId), nodes.filter((node) => !doomedSet.has(node.id)));
      await this.writeJson(this.threadsFile(workspaceId), threads.filter((thread) => !doomedSet.has(thread.nodeId)));
      await Promise.all(
        doomedThreads.map(async (thread) => {
          await rm(this.threadFile(workspaceId, thread.id), { force: true });
        })
      );
      await Promise.all(doomed.map((id) => rm(this.cardFile(workspaceId, id), { force: true })));
      await this.touch(workspaceId);
      return doomed;
    });
  }
  // ── 线程与消息 ────────────────────────────────────────────────────────────
  async getThread(threadId) {
    const { workspaceId, node, thread } = await this.findThread(threadId);
    const [workspace, messages, card, nodes, threads] = await Promise.all([
      this.requireWorkspace(workspaceId),
      this.readMessages(workspaceId, threadId),
      thread.kind === "main" ? this.readJson(this.cardFile(workspaceId, node.id)) : void 0,
      this.readJson(this.nodesFile(workspaceId)),
      this.readJson(this.threadsFile(workspaceId))
    ]);
    const subthreads = thread.kind === "main" ? await Promise.all(
      (threads ?? []).filter((item) => item.nodeId === node.id && item.kind === "sub").sort((a, b) => a.order - b.order).map(async (item) => ({
        thread: item,
        messages: await this.readMessages(workspaceId, item.id)
      }))
    ) : void 0;
    return {
      workspace,
      thread,
      messages,
      card: card ?? void 0,
      path: await this.pathBriefs(workspaceId, node, nodes ?? []),
      node,
      subthreads
    };
  }
  async getNode(nodeId) {
    return (await this.findNode(nodeId)).node;
  }
  async recordVisit(nodeId, openedAt, durationMs) {
    return this.mutate(async () => {
      const { workspaceId, nodes, node } = await this.findNode(nodeId);
      const next = {
        ...node,
        lastOpenedAt: openedAt,
        lastDurationMs: clamp(Math.round(durationMs), 0, 12 * 60 * 60 * 1e3),
        openCount: (node.openCount ?? 0) + 1,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.writeJson(this.nodesFile(workspaceId), nodes.map((item) => item.id === nodeId ? next : item));
      await this.touch(workspaceId);
      return next;
    });
  }
  async listSubthreads(nodeId) {
    const { workspaceId } = await this.findNode(nodeId);
    const threads = await this.readJson(this.threadsFile(workspaceId)) ?? [];
    return threads.filter((thread) => thread.nodeId === nodeId && thread.kind === "sub").sort((a, b) => a.order - b.order);
  }
  async createSubthread(nodeId, input) {
    return this.mutate(async () => {
      const { workspaceId, node } = await this.findNode(nodeId);
      const threads = await this.readJson(this.threadsFile(workspaceId)) ?? [];
      const siblings = threads.filter((thread2) => thread2.nodeId === nodeId && thread2.kind === "sub");
      const thread = {
        id: `t_${shortId()}`,
        nodeId,
        parentThreadId: node.threadId,
        anchorMessageId: input.anchorMessageId,
        kind: "sub",
        title: input.title.trim() || "\u672A\u547D\u540D\u5B50\u804A\u5929",
        order: siblings.length,
        collapsed: false,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.writeJson(this.threadsFile(workspaceId), [...threads, thread]);
      await this.touch(workspaceId);
      return thread;
    });
  }
  async setThreadCollapsed(threadId, collapsed) {
    return this.mutate(async () => {
      const { workspaceId, thread } = await this.findThread(threadId);
      const threads = await this.readJson(this.threadsFile(workspaceId)) ?? [];
      const next = { ...thread, collapsed };
      await this.writeJson(this.threadsFile(workspaceId), threads.map((item) => item.id === threadId ? next : item));
      return next;
    });
  }
  async appendMessage(threadId, role, content, quote) {
    return this.mutate(async () => {
      const { workspaceId } = await this.findThread(threadId);
      const messages = await this.readMessages(workspaceId, threadId);
      if (messages.length >= 2e3) throw new Error("E_BUDGET: \u7EBF\u7A0B\u6D88\u606F\u5DF2\u8FBE\u4E0A\u9650");
      const message = {
        id: `m_${shortId()}`,
        threadId,
        role,
        content,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        quote
      };
      await this.appendJsonl(this.threadFile(workspaceId, threadId), message);
      return message;
    });
  }
  async updateMessage(workspaceId, threadId, messageId, content, error = false) {
    return this.mutate(async () => {
      const messages = await this.readMessages(workspaceId, threadId);
      const next = messages.map(
        (message) => message.id === messageId ? { ...message, content, error } : message
      );
      await this.writeJsonl(this.threadFile(workspaceId, threadId), next);
    });
  }
  async recentMessages(workspaceId, threadId, limit) {
    const messages = await this.readMessages(workspaceId, threadId);
    return messages.slice(-limit);
  }
  async pathBriefs(workspaceId, node, nodes) {
    const path = [];
    let current = node;
    while (current) {
      const card = await this.readJson(this.cardFile(workspaceId, current.id));
      path.unshift({ nodeId: current.id, title: current.title, tldr: card?.tldr });
      current = current.parentId ? nodes.find((item) => item.id === current?.parentId) : void 0;
    }
    return path;
  }
  // ── 收口卡 ────────────────────────────────────────────────────────────────
  async saveCard(card) {
    return this.mutate(async () => {
      const { workspaceId, node } = await this.findNode(card.nodeId);
      await this.writeJson(this.cardFile(workspaceId, node.id), card);
      const nodes = await this.readJson(this.nodesFile(workspaceId)) ?? [];
      const next = {
        ...node,
        status: "closed",
        mastery: clamp(Math.round(card.mastery), 0, 5),
        closedAt: card.generatedAt,
        updatedAt: card.generatedAt
      };
      await this.writeJson(this.nodesFile(workspaceId), nodes.map((item) => item.id === node.id ? next : item));
      await this.touch(workspaceId);
      return card;
    });
  }
  async getCard(nodeId) {
    const { workspaceId } = await this.findNode(nodeId);
    return await this.readJson(this.cardFile(workspaceId, nodeId)) ?? void 0;
  }
  // ── 搜索 ──────────────────────────────────────────────────────────────────
  async search(workspaceId, query) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const snapshot = await this.snapshot(workspaceId);
    const threads = await this.readJson(this.threadsFile(workspaceId)) ?? [];
    const results = [];
    for (const node of snapshot.nodes) {
      if (match(node.title, needle) || match(node.subtitle ?? "", needle)) {
        results.push({ kind: "node", id: node.id, nodeId: node.id, title: node.title, excerpt: node.subtitle ?? "" });
      }
      const card = await this.readJson(this.cardFile(workspaceId, node.id));
      if (card && [card.tldr, ...card.points, ...card.openQuestions].some((text2) => match(text2, needle))) {
        results.push({ kind: "card", id: card.id, nodeId: node.id, title: node.title, excerpt: card.tldr });
      }
      for (const thread of threads.filter((item) => item.nodeId === node.id)) {
        const messages = await this.readMessages(workspaceId, thread.id);
        for (const message of messages) {
          if (match(message.content, needle)) {
            results.push({
              kind: "message",
              id: message.id,
              nodeId: node.id,
              title: node.title,
              excerpt: excerptAround(message.content, needle)
            });
            if (results.length >= 40) return results;
          }
        }
      }
    }
    return results.slice(0, 40);
  }
  // ── 内部：读取与写入 ──────────────────────────────────────────────────────
  async findNode(nodeId) {
    for (const workspace of await this.listWorkspaces()) {
      const nodes = await this.readJson(this.nodesFile(workspace.id)) ?? [];
      const node = nodes.find((item) => item.id === nodeId);
      if (node) return { workspaceId: workspace.id, nodes, node };
    }
    throw new Error("E_NOT_FOUND: \u8282\u70B9\u4E0D\u5B58\u5728");
  }
  async findThread(threadId) {
    for (const workspace of await this.listWorkspaces()) {
      const threads = await this.readJson(this.threadsFile(workspace.id)) ?? [];
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) continue;
      const nodes = await this.readJson(this.nodesFile(workspace.id)) ?? [];
      const node = nodes.find((item) => item.id === thread.nodeId);
      if (node) return { workspaceId: workspace.id, thread, node };
    }
    throw new Error("E_NOT_FOUND: \u7EBF\u7A0B\u4E0D\u5B58\u5728");
  }
  async requireWorkspace(workspaceId) {
    if (!SAFE_ID.test(workspaceId)) throw new Error("E_BAD_REQUEST: \u975E\u6CD5\u5DE5\u4F5C\u533A id");
    const workspace = await this.readJson(this.workspaceFile(workspaceId));
    if (!workspace) throw new Error("E_NOT_FOUND: \u5DE5\u4F5C\u533A\u4E0D\u5B58\u5728");
    return workspace;
  }
  async touch(workspaceId) {
    const workspace = await this.requireWorkspace(workspaceId);
    await this.writeJson(this.workspaceFile(workspaceId), {
      ...workspace,
      rev: workspace.rev + 1,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  async readMessages(workspaceId, threadId) {
    const text2 = await readFile(this.threadFile(workspaceId, threadId), "utf8").catch(() => "");
    const messages = [];
    for (const line of text2.split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
      }
    }
    return messages;
  }
  async readJson(file) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return void 0;
    }
  }
  async writeJson(file, value) {
    await this.writeAtomic(file, `${JSON.stringify(value, null, 2)}
`);
  }
  async writeJsonl(file, rows) {
    await this.writeAtomic(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  }
  async appendJsonl(file, row) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(row)}
`, { flag: "a", encoding: "utf8" });
  }
  async writeAtomic(file, data) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, data, "utf8");
    try {
      await rename(tmp, file);
    } catch (error) {
      await rm(file, { force: true });
      await rename(tmp, file).catch(async (retryError) => {
        await rm(tmp, { force: true });
        throw retryError ?? error;
      });
    }
  }
  mutate(fn) {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  workspacesRoot() {
    return join(this.root, "workspaces");
  }
  workspaceDir(workspaceId) {
    return join(this.workspacesRoot(), workspaceId);
  }
  workspaceFile(workspaceId) {
    return join(this.workspaceDir(workspaceId), "workspace.json");
  }
  nodesFile(workspaceId) {
    return join(this.workspaceDir(workspaceId), "nodes.json");
  }
  threadsFile(workspaceId) {
    return join(this.workspaceDir(workspaceId), "threads.json");
  }
  viewportFile(workspaceId) {
    return join(this.workspaceDir(workspaceId), "viewport.json");
  }
  threadFile(workspaceId, threadId) {
    return join(this.workspaceDir(workspaceId), "threads", `${threadId}.jsonl`);
  }
  cardFile(workspaceId, nodeId) {
    return join(this.workspaceDir(workspaceId), "cards", `${nodeId}.json`);
  }
};
function shortId() {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}
function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function defaultPosition(parent, siblingIndex) {
  if (parent) {
    return {
      x: parent.position.x + NODE_W + 96,
      y: parent.position.y + siblingIndex * (NODE_H + 34)
    };
  }
  return { x: 80, y: 80 + siblingIndex * (NODE_H + 34) };
}
function descendantsOf(rootId, nodes) {
  const doomed = [rootId];
  for (let index = 0; index < doomed.length; index++) {
    const parentId = doomed[index];
    for (const node of nodes) {
      if (node.parentId === parentId && !doomed.includes(node.id)) doomed.push(node.id);
    }
  }
  return doomed;
}
function match(text2, needle) {
  return text2.toLocaleLowerCase().includes(needle);
}
function excerptAround(text2, needle, radius = 48) {
  const lower = text2.toLocaleLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) return text2.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text2.length, at + needle.length + radius);
  return `${start > 0 ? "\u2026" : ""}${text2.slice(start, end)}${end < text2.length ? "\u2026" : ""}`;
}

// src/host/model.ts
var AtlasModel = class {
  constructor(llm, config = {}, defaultSelection) {
    this.llm = llm;
    this.config = config;
    this.defaultSelection = defaultSelection;
  }
  routeCache;
  async run(options) {
    const route2 = await this.route();
    const chunks = this.requireLlm().stream({
      provider: route2.provider,
      model: route2.model,
      system: options.system,
      messages: options.messages,
      maxTokens: options.maxTokens ?? this.config.maxTokens ?? 1600,
      signal: options.signal
    });
    let text2 = "";
    let usage = { input: 0, output: 0 };
    for await (const chunk of chunks) {
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        text2 += chunk.text;
        options.onDelta?.(chunk.text);
      } else if (chunk.type === "usage" && chunk.usage) {
        usage = {
          input: chunk.usage.inputTokens ?? 0,
          output: chunk.usage.outputTokens ?? 0
        };
      } else if (chunk.type === "finish") {
        const kind = chunk.reason?.kind;
        if (kind === "error" || kind === "aborted") {
          throw new Error(`E_MODEL: ${chunk.reason?.failure?.message ?? "\u6A21\u578B\u8C03\u7528\u5931\u8D25"}`);
        }
      }
    }
    if (!text2.trim()) throw new Error("E_MODEL: \u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u5185\u5BB9");
    return { text: text2, provider: route2.provider, model: route2.model, usage };
  }
  async json(options) {
    const result = await this.run({ ...options, maxTokens: options.maxTokens ?? 1200 });
    return { value: parseJson(result.text), model: result.model };
  }
  async route() {
    this.routeCache ??= this.resolveRoute().catch((error) => {
      this.routeCache = void 0;
      throw error;
    });
    return this.routeCache;
  }
  async resolveRoute() {
    const llm = this.requireLlm();
    const defaults = this.defaultSelection?.();
    const providers = llm.listProviders();
    if (providers.length === 0) {
      throw new Error(
        "E_AUTH: \u6CA1\u6709\u53EF\u7528\u7684\u6A21\u578B provider\u3002\u8BF7\u5148\u5728 DSH \u8BBE\u7F6E \u2192 \u6A21\u578B \u4E2D\u914D\u7F6E provider \u4E0E API key\u3002"
      );
    }
    const provider = providers.find((item) => item.id === this.config.provider)?.id ?? providers.find((item) => item.id === defaults?.provider)?.id ?? providers.find((item) => item.id === "deepseek-official")?.id ?? providers[0].id;
    let models = [];
    try {
      models = await llm.listModels(provider);
    } catch {
    }
    const model = this.config.model ?? defaults?.model ?? models[0]?.id;
    if (!model) {
      throw new Error(
        `E_MODEL: provider\u300C${provider}\u300D\u6CA1\u6709\u53EF\u7528\u6A21\u578B\u3002\u8BF7\u68C0\u67E5 DSH \u8BBE\u7F6E \u2192 \u6A21\u578B\uFF0C\u6216\u5728 Atlas \u914D\u7F6E\u4E2D\u663E\u5F0F\u6307\u5B9A model\u3002`
      );
    }
    return { provider, model };
  }
  requireLlm() {
    if (!this.llm) throw new Error("E_UNSUPPORTED: \u5F53\u524D DSH \u6CA1\u6709\u63D0\u4F9B llm.stream \u80FD\u529B");
    return this.llm;
  }
};
function parseJson(text2) {
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text2);
  if (fence?.[1]) candidates.push(fence[1]);
  const start = text2.indexOf("{");
  const end = text2.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text2.slice(start, end + 1));
  candidates.push(text2);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
      } catch {
      }
    }
  }
  const salvaged = salvageFields(text2);
  if (salvaged) return salvaged;
  if (start < 0 || end <= start) throw new Error("E_VALIDATION: \u6A21\u578B\u6CA1\u6709\u8FD4\u56DE JSON \u5BF9\u8C61");
  throw new Error("E_VALIDATION: \u6A21\u578B\u8FD4\u56DE\u7684 JSON \u65E0\u6CD5\u89E3\u6790");
}
function salvageFields(text2) {
  const pick = (key) => {
    const matched = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text2);
    if (!matched?.[1]) return void 0;
    const value = matched[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "	").replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
    return value || void 0;
  };
  const term = pick("term");
  const meaning = pick("meaning");
  const inContext = pick("inContext");
  if (!term && !meaning && !inContext) return void 0;
  return { ...term ? { term } : {}, ...meaning ? { meaning } : {}, ...inContext ? { inContext } : {} };
}

// src/host/context.ts
var SYSTEM = `\u4F60\u662F Atlas \u4E2D\u7684\u5B66\u4E60\u4E0E\u5206\u6790\u52A9\u624B\u3002\u5F53\u524D\u8282\u70B9\uFF1A{{title}}\u3002
\u5730\u56FE\u76EE\u6807\uFF1A{{goal}}
\u8DEF\u5F84\uFF1A{{path}}

\u4F60\u7684\u4EFB\u52A1\uFF1A
1. \u53EA\u5728\u8FD9\u4E2A\u8282\u70B9\u7684\u8303\u56F4\u5185\u56DE\u7B54\uFF1B\u4E0D\u8981\u91CD\u590D\u7956\u5148\u8282\u70B9\u5DF2\u7ECF\u8BB2\u8FC7\u7684\u5185\u5BB9\u3002
2. \u5148\u7ED9\u7ED3\u8BBA\uFF0C\u518D\u7ED9 2\u20134 \u6761\u8981\u70B9\uFF1B\u9700\u8981\u65F6\u8865\u4E00\u4E2A\u4F8B\u5B50\u3002
3. \u56DE\u7B54\u5C3D\u91CF\u77ED\uFF0C\u4F7F\u7528 Markdown\uFF1B\u6807\u9898\u7528 ## / ###\uFF0C\u65B9\u4FBF\u6298\u53E0\u4E0E\u5B9A\u4F4D\u3002
4. \u5982\u679C\u95EE\u9898\u660E\u663E\u8D85\u51FA\u5F53\u524D\u8282\u70B9\uFF0C\u63D0\u9192\u7528\u6237\u53EF\u4EE5\u201C\u63D0\u5347\u4E3A\u8282\u70B9\u201D\u6216\u56DE\u5230\u4E0A\u5C42\u3002
5. \u4E0D\u786E\u5B9A\u7684\u5185\u5BB9\u76F4\u8BF4\uFF0C\u4E0D\u8981\u7F16\u9020\u3002`;
function buildChatContext(input) {
  const { workspace, node, path, card } = input;
  const recent = trimMessages(input.messages, 24e3, 12);
  const ancestors = path.filter((item) => item.nodeId !== node.id).map((item) => `- ${item.title}${item.tldr ? `\uFF1A${item.tldr}` : ""}`).join("\n");
  const resume = card ? `

\u3010\u7EED\u63A5\u7B80\u62A5\u3011
\u4E0A\u6B21\u7ED3\u8BBA\uFF1A${card.tldr}
\u5DF2\u5F97\u8981\u70B9\uFF1A
${card.points.map((point) => `- ${point}`).join("\n")}
\u672A\u89E3\u95EE\u9898\uFF1A
${card.openQuestions.length ? card.openQuestions.map((q) => `- ${q}`).join("\n") : "\uFF08\u65E0\uFF09"}` : "";
  const parent = input.parentMessages?.length ? `

\u3010\u7236\u7EBF\u7A0B\u6700\u8FD1\u4E24\u8F6E\u3011
${input.parentMessages.slice(-2).map((message) => `${message.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}\uFF1A${message.content.slice(0, 800)}`).join("\n")}` : "";
  const system = SYSTEM.replace("{{title}}", node.title).replace("{{goal}}", workspace.goal ?? "\uFF08\u672A\u586B\u5199\uFF09").replace("{{path}}", path.map((item) => item.title).join(" \u203A ") || node.title).concat(ancestors ? `

\u7956\u5148\u8282\u70B9\u7684\u6536\u53E3\u5361\uFF1A
${ancestors}` : "").concat(parent).concat(resume);
  const messages = recent.map((message) => ({
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: [
      {
        type: "text",
        text: message.quote ? `> ${message.quote.text}

${message.content}` : message.content
      }
    ],
    source: message.role === "assistant" ? { kind: "model", provider: "atlas", model: "atlas" } : { kind: "user" }
  }));
  return { system, messages };
}
function buildClosureContext(input) {
  const transcript = trimMessages(input.messages, 24e3, 30).map((message) => `${message.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}\uFF1A${message.content}`).join("\n\n");
  const system = `\u4F60\u662F Atlas \u7684\u6536\u53E3\u7F16\u8F91\u3002\u7ED9\u5B9A\u4E00\u6BB5\u5BF9\u8BDD\u3001\u8282\u70B9\u76EE\u6807\u548C\u7956\u5148\u8DEF\u5F84\uFF0C\u8F93\u51FA\u4E25\u683C JSON\u3002
\u53EA\u5199\u5BF9\u8BDD\u91CC\u5DF2\u7ECF\u6210\u7ACB\u7684\u7ED3\u8BBA\uFF0C\u4E0D\u5F15\u5165\u65B0\u4E8B\u5B9E\uFF1B\u4E0D\u786E\u5B9A\u7684\u5185\u5BB9\u653E\u8FDB openQuestions\u3002
tldr \u4E0D\u8D85\u8FC7 30 \u4E2A\u6C49\u5B57\uFF1Bpoints 3\u20137 \u6761\uFF0C\u6BCF\u6761\u4E0D\u8D85\u8FC7 40 \u5B57\uFF1BopenQuestions 0\u20133 \u6761\u3002
mastery \u4E3A 0\u20135 \u7684\u6574\u6570\u5E76\u7ED9\u4E00\u53E5\u7406\u7531\uFF1BnextHint \u662F\u4E00\u53E5\u56DE\u5230\u4E0A\u5C42\u7684\u8854\u63A5\u53E5\u3002
JSON \u5F62\u72B6\uFF1A
{"tldr":string,"points":string[],"openQuestions":string[],"artifacts":[{"kind":"file|link|code|table|image","ref":string,"label":string}],"mastery":number,"masteryReason":string,"nextHint":string}`;
  const user = `\u8282\u70B9\uFF1A${input.node.title}
\u5730\u56FE\u76EE\u6807\uFF1A${input.workspace.goal ?? "\uFF08\u672A\u586B\u5199\uFF09"}
\u8DEF\u5F84\uFF1A${input.path.map((item) => item.title).join(" \u203A ") || input.node.title}

\u5BF9\u8BDD\uFF1A
${transcript || "\uFF08\u8FD8\u6CA1\u6709\u5BF9\u8BDD\uFF09"}`;
  return {
    system,
    messages: [{ role: "user", content: [{ type: "text", text: user }], source: { kind: "user" } }]
  };
}
function buildExplainContext(input) {
  const recent = trimMessages(input.messages, 6e3, 8).map((message) => `${message.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}\uFF1A${message.content.slice(0, 1200)}`).join("\n\n");
  const system = `\u4F60\u662F Atlas \u7684\u672F\u8BED\u89E3\u91CA\u52A9\u624B\u3002\u7ED3\u5408\u5F53\u524D\u8282\u70B9\u4E0E\u5BF9\u8BDD\u4E0A\u4E0B\u6587\uFF0C\u89E3\u91CA\u7528\u6237\u9009\u4E2D\u7684\u8BCD\u6216\u77ED\u8BED\u3002
\u53EA\u89E3\u91CA\u9009\u4E2D\u5185\u5BB9\uFF0C\u4E0D\u5C55\u5F00\u65E0\u5173\u8BDD\u9898\u3002\u8F93\u51FA\u4E25\u683C JSON\uFF1A
{"term":string,"meaning":string,"inContext":string}
meaning \u662F\u8FD9\u4E2A\u8BCD\u7684\u901A\u7528\u542B\u4E49\uFF0C1\u20132 \u53E5\uFF1BinContext \u662F\u5B83\u5728\u8FD9\u6BB5\u5BF9\u8BDD\u91CC\u7684\u5177\u4F53\u542B\u4E49\uFF0C1\u20132 \u53E5\u3002`;
  const user = `\u8282\u70B9\uFF1A${input.node.title}
\u8DEF\u5F84\uFF1A${input.path.map((item) => item.title).join(" \u203A ") || input.node.title}
\u5730\u56FE\u76EE\u6807\uFF1A${input.workspace.goal ?? "\uFF08\u672A\u586B\u5199\uFF09"}

\u6700\u8FD1\u5BF9\u8BDD\uFF1A
${recent || "\uFF08\u6682\u65E0\uFF09"}

\u9009\u4E2D\u6587\u5B57\uFF1A${input.text}`;
  return {
    system,
    messages: [{ role: "user", content: [{ type: "text", text: user }], source: { kind: "user" } }]
  };
}
function trimMessages(messages, budget, maxCount) {
  const recent = messages.filter((message) => message.role !== "system").slice(-maxCount);
  let total = recent.reduce((sum, message) => sum + message.content.length, 0);
  let start = 0;
  while (start < recent.length - 1 && total > budget) {
    total -= recent[start].content.length;
    start++;
  }
  return recent.slice(start);
}

// src/host/closure.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var ARTIFACT_KINDS = /* @__PURE__ */ new Set(["file", "link", "code", "table", "image"]);
async function generateClosure(store, model, node, threadId) {
  const threadSnapshot = await store.getThread(threadId);
  if (threadSnapshot.messages.length === 0) {
    return store.saveCard(fallbackCard(node, threadSnapshot.thread, [], "empty"));
  }
  const context = buildClosureContext({
    workspace: threadSnapshot.workspace,
    node,
    path: threadSnapshot.path,
    messages: threadSnapshot.messages
  });
  try {
    const { value, model: modelName } = await model.json({
      system: context.system,
      messages: context.messages,
      maxTokens: 1200
    });
    return store.saveCard(normalizeCard(value, node, threadSnapshot.thread, threadSnapshot.messages, modelName));
  } catch {
    return store.saveCard(
      fallbackCard(node, threadSnapshot.thread, threadSnapshot.messages, "model-failed")
    );
  }
}
function normalizeCard(raw, node, thread, messages, model) {
  const tldr = text(raw.tldr)?.slice(0, 120) ?? "\uFF08\u6A21\u578B\u672A\u7ED9\u51FA\u7ED3\u8BBA\uFF09";
  const points = stringList(raw.points, 7).slice(0, 7);
  const openQuestions = stringList(raw.openQuestions, 3).slice(0, 3);
  const mastery = clampInt(raw.mastery, 0, 5, node.mastery);
  const artifacts = artifactList(raw.artifacts);
  const sourceRange = messages.length ? [messages[0].id, messages[messages.length - 1].id] : [];
  return {
    id: `c_${randomUUID2().replaceAll("-", "").slice(0, 12)}`,
    nodeId: node.id,
    threadId: thread.id,
    tldr,
    points: points.length ? points : [tldr],
    openQuestions,
    artifacts,
    mastery,
    masteryReason: text(raw.masteryReason)?.slice(0, 160) ?? "\u6A21\u578B\u4F9D\u636E\u672C\u8F6E\u5BF9\u8BDD\u7ED9\u51FA\u7684\u4F30\u8BA1\u3002",
    nextHint: text(raw.nextHint)?.slice(0, 160) ?? "\u56DE\u5230\u4E0A\u5C42\uFF0C\u628A\u8FD9\u4E2A\u8282\u70B9\u653E\u56DE\u5730\u56FE\u3002",
    sourceRange,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    model,
    version: 1
  };
}
function fallbackCard(node, thread, messages, reason) {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const content = lastAssistant?.content.trim() ?? "";
  const lines = content.split("\n").map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).filter(Boolean);
  const tldr = (lines[0] ?? (reason === "empty" ? "\u8FD8\u6CA1\u6709\u5F00\u59CB\u5BF9\u8BDD\u3002" : "\u81EA\u52A8\u6536\u53E3\u4E0D\u53EF\u7528\uFF0C\u8BF7\u624B\u52A8\u8865\u5145\u7ED3\u8BBA\u3002")).slice(0, 120);
  const points = lines.slice(0, 5).map((line) => line.slice(0, 80));
  const sourceRange = messages.length ? [messages[0].id, messages[messages.length - 1].id] : [];
  return {
    id: `c_${randomUUID2().replaceAll("-", "").slice(0, 12)}`,
    nodeId: node.id,
    threadId: thread.id,
    tldr,
    points: points.length ? points : [tldr],
    openQuestions: reason === "model-failed" ? ["\u68C0\u67E5\u6A21\u578B\u914D\u7F6E\u540E\u91CD\u65B0\u6536\u53E3\uFF0C\u6216\u624B\u52A8\u8865\u5145\u672A\u89E3\u95EE\u9898\u3002"] : [],
    artifacts: [],
    mastery: reason === "empty" ? 0 : Math.max(1, node.mastery),
    masteryReason: reason === "empty" ? "\u5C1A\u672A\u5F00\u59CB\u3002" : "\u81EA\u52A8\u6536\u53E3\u4E0D\u53EF\u7528\uFF0C\u638C\u63E1\u5EA6\u7531\u6700\u8FD1\u4E00\u8F6E\u56DE\u7B54\u4F30\u8BA1\u3002",
    nextHint: "\u56DE\u5230\u5730\u56FE\uFF0C\u51B3\u5B9A\u4E0B\u4E00\u6B65\u3002",
    sourceRange,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    model: reason === "empty" ? "empty" : "fallback",
    version: 1
  };
}
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function stringList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 160)).slice(0, limit);
}
function artifactList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "object" && item !== null).map((item) => {
    const kind = typeof item["kind"] === "string" ? item["kind"] : "";
    const ref = text(item["ref"]);
    if (!ref || !ARTIFACT_KINDS.has(kind)) return void 0;
    return {
      kind,
      ref,
      ...text(item["label"]) ? { label: text(item["label"]) } : {}
    };
  }).filter((item) => item !== void 0).slice(0, 8);
}
function clampInt(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// src/host/actions.ts
async function promoteSubthread(store, threadId, options = {}) {
  const snapshot = await store.getThread(threadId);
  if (snapshot.thread.kind !== "sub") throw new Error("E_BAD_REQUEST: \u53EA\u6709\u5B50\u804A\u5929\u53EF\u4EE5\u63D0\u5347\u4E3A\u8282\u70B9");
  const title = options.title?.trim() || snapshot.thread.title || firstLine(snapshot.messages.find((message) => message.role === "user")?.content ?? "") || "\u65B0\u7684\u5B50\u8282\u70B9";
  const parent = snapshot.node;
  const { node } = await store.createNode({
    workspaceId: parent.workspaceId,
    parentId: parent.id,
    title,
    subtitle: `\u4ECE\u300C${parent.title}\u300D\u63D0\u5347`,
    position: options.position
  });
  for (const message of snapshot.messages) {
    if (message.role === "system") continue;
    await store.appendMessage(node.threadId, message.role, message.content, message.quote);
  }
  const promoted = snapshot.messages.length > 0 ? await store.updateNode(node.id, { status: "active" }) : node;
  await store.setThreadCollapsed(threadId, true);
  return promoted;
}
function firstLine(text2) {
  return text2.split("\n").find((line) => line.trim())?.trim().slice(0, 60) ?? "";
}

// src/host/routes.ts
function createAtlasRouter(deps) {
  return async (rawReq, rawRes) => {
    const req = rawReq;
    const res = rawRes;
    try {
      await route(req, res, deps);
    } catch (error) {
      sendError(res, error);
    }
  };
}
async function route(req, res, deps) {
  const url = new URL(req.url ?? "/", "http://atlas.local");
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "ext" || segments[1] !== "atlas") {
    return send(res, 404, { error: { code: "E_NOT_FOUND", message: "Not found" } });
  }
  const path = segments.slice(2);
  const method = (req.method ?? "GET").toUpperCase();
  if (path.length === 1 && path[0] === "update") {
    allow(method, ["GET"]);
    return send(res, 200, await deps.checkUpdate(url.searchParams.get("force") === "1"));
  }
  if (path.length === 1 && path[0] === "bootstrap") {
    allow(method, ["GET"]);
    const workspace = await deps.store.ensureWorkspace();
    const [workspaces, snapshot] = await Promise.all([
      deps.store.listWorkspaces(),
      deps.store.snapshot(workspace.id)
    ]);
    return send(res, 200, { workspaces, snapshot, dataDir: deps.dataDir });
  }
  if (path[0] === "workspaces") {
    if (path.length === 1) {
      allow(method, ["GET", "POST"]);
      if (method === "GET") return send(res, 200, { workspaces: await deps.store.listWorkspaces() });
      const body = await readJson(req);
      if (!body.name?.trim()) throw new Error("E_BAD_REQUEST: \u5DE5\u4F5C\u533A\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
      const workspace = await deps.store.createWorkspace(body.name, body.goal);
      return send(res, 200, {
        workspace,
        snapshot: await deps.store.snapshot(workspace.id),
        workspaces: await deps.store.listWorkspaces()
      });
    }
    const workspaceId = decode(path[1]);
    if (path.length === 2) {
      allow(method, ["GET", "PATCH"]);
      if (method === "GET") return send(res, 200, { snapshot: await deps.store.snapshot(workspaceId) });
      const body = await readJson(req);
      if (body.active) await deps.store.setActive(workspaceId);
      else await deps.store.updateWorkspace(workspaceId, body);
      return send(res, 200, {
        snapshot: await deps.store.snapshot(workspaceId),
        workspaces: await deps.store.listWorkspaces()
      });
    }
    if (path.length === 3 && path[2] === "viewport") {
      allow(method, ["PATCH"]);
      const body = await readJson(req);
      if (!body.viewport) throw new Error("E_BAD_REQUEST: \u7F3A\u5C11 viewport");
      return send(res, 200, { viewport: await deps.store.saveViewport(workspaceId, body.viewport) });
    }
  }
  if (path[0] === "nodes") {
    if (path.length === 1) {
      allow(method, ["POST"]);
      const body = await readJson(req);
      if (!body.workspaceId || !body.title?.trim()) {
        throw new Error("E_BAD_REQUEST: \u9700\u8981 workspaceId \u548C title");
      }
      const created = await deps.store.createNode(body);
      return send(res, 200, created);
    }
    const nodeId = decode(path[1]);
    if (path.length === 2) {
      allow(method, ["PATCH", "DELETE"]);
      if (method === "PATCH") {
        const body = await readJson(req);
        const node = await deps.store.updateNode(nodeId, body);
        return send(res, 200, { node });
      }
      const deleted = await deps.store.deleteNode(nodeId);
      return send(res, 200, { deleted });
    }
    if (path.length === 3 && path[2] === "close") {
      allow(method, ["POST"]);
      const body = await readJson(req);
      const node = await deps.store.getNode(nodeId);
      const threadId = body.threadId ?? node.threadId;
      const thread = await deps.store.getThread(threadId);
      if (thread.node.id !== node.id) throw new Error("E_BAD_REQUEST: \u7EBF\u7A0B\u4E0D\u5C5E\u4E8E\u8BE5\u8282\u70B9");
      const card = await generateClosure(deps.store, deps.model, node, threadId);
      return send(res, 200, { card, node: await deps.store.getNode(nodeId) });
    }
    if (path.length === 3 && path[2] === "visit") {
      allow(method, ["POST"]);
      const body = await readJson(req);
      if (typeof body.durationMs !== "number" || !Number.isFinite(body.durationMs) || body.durationMs < 0) {
        throw new Error("E_BAD_REQUEST: durationMs \u4E0D\u5408\u6CD5");
      }
      const openedAt = typeof body.openedAt === "string" && !Number.isNaN(Date.parse(body.openedAt)) ? new Date(body.openedAt).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
      return send(res, 200, { node: await deps.store.recordVisit(nodeId, openedAt, body.durationMs) });
    }
  }
  if (path[0] === "threads") {
    if (path.length === 1) {
      allow(method, ["POST"]);
      const body = await readJson(req);
      if (!body.nodeId || !body.title?.trim()) throw new Error("E_BAD_REQUEST: \u9700\u8981 nodeId \u548C title");
      const thread = await deps.store.createSubthread(body.nodeId, body);
      return send(res, 200, { thread });
    }
    const threadId = decode(path[1]);
    if (path.length === 2) {
      allow(method, ["GET", "PATCH"]);
      if (method === "GET") return send(res, 200, { snapshot: await deps.store.getThread(threadId) });
      const body = await readJson(req);
      const thread = await deps.store.setThreadCollapsed(threadId, body.collapsed ?? true);
      return send(res, 200, { thread });
    }
    if (path.length === 3 && path[2] === "turn") {
      allow(method, ["POST"]);
      return turn(req, res, deps, threadId);
    }
    if (path.length === 3 && path[2] === "promote") {
      allow(method, ["POST"]);
      const body = await readJson(req);
      const node = await promoteSubthread(deps.store, threadId, {
        title: body.title,
        position: body.position
      });
      return send(res, 200, { node });
    }
    if (path.length === 3 && path[2] === "explain") {
      allow(method, ["POST"]);
      const body = await readJson(req);
      const selected = body.text?.trim();
      if (!selected) throw new Error("E_BAD_REQUEST: \u6CA1\u6709\u9009\u4E2D\u6587\u5B57");
      if (selected.length > 200) throw new Error("E_BAD_REQUEST: \u9009\u4E2D\u6587\u5B57\u6700\u591A 200 \u5B57");
      const snapshot = await deps.store.getThread(threadId);
      const context = buildExplainContext({
        workspace: snapshot.workspace,
        node: snapshot.node,
        path: snapshot.path,
        messages: snapshot.messages,
        text: selected
      });
      const { value, model } = await deps.model.json({
        system: context.system,
        messages: context.messages,
        maxTokens: 800
      });
      return send(res, 200, {
        term: asText(value.term) ?? selected,
        meaning: asText(value.meaning) ?? "\u6A21\u578B\u6CA1\u6709\u7ED9\u51FA\u901A\u7528\u542B\u4E49\u3002",
        inContext: asText(value.inContext) ?? "\u6A21\u578B\u6CA1\u6709\u7ED9\u51FA\u5F53\u524D\u8BED\u5883\u4E0B\u7684\u89E3\u91CA\u3002",
        model
      });
    }
  }
  if (path.length === 1 && path[0] === "search") {
    allow(method, ["GET"]);
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!q) return send(res, 200, { hits: [] });
    let workspaceId = url.searchParams.get("workspaceId") ?? "";
    if (!workspaceId) workspaceId = (await deps.store.ensureWorkspace()).id;
    return send(res, 200, { hits: await deps.store.search(workspaceId, q) });
  }
  send(res, 404, { error: { code: "E_NOT_FOUND", message: `\u672A\u77E5\u8DEF\u7531\uFF1A${url.pathname}` } });
}
async function turn(req, res, deps, threadId) {
  const body = await readJson(req);
  const text2 = body.text?.trim();
  if (!text2) throw new Error("E_BAD_REQUEST: \u6D88\u606F\u4E0D\u80FD\u4E3A\u7A7A");
  if (text2.length > LIMITS.maxMessageChars) throw new Error("E_BUDGET: \u5355\u6761\u6D88\u606F\u8FC7\u957F");
  const snapshot = await deps.store.getThread(threadId);
  const { workspace, node } = snapshot;
  const userMessage = await deps.store.appendMessage(threadId, "user", text2, body.quote);
  if (node.status !== "active") await deps.store.updateNode(node.id, { status: "active" });
  const parentMessages = snapshot.thread.kind === "sub" && snapshot.thread.parentThreadId ? (await deps.store.getThread(snapshot.thread.parentThreadId)).messages.slice(-2) : void 0;
  const context = buildChatContext({
    workspace,
    node,
    path: snapshot.path,
    card: snapshot.card,
    messages: [...snapshot.messages, userMessage],
    parentMessages
  });
  const assistant = await deps.store.appendMessage(threadId, "assistant", "");
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders?.();
  event(res, "meta", { threadId, messageId: assistant.id, model: deps.modelHint });
  let streamed = "";
  try {
    const result = await deps.model.run({
      system: context.system,
      messages: context.messages,
      signal: controller.signal,
      onDelta: (delta) => {
        streamed += delta;
        event(res, "delta", { messageId: assistant.id, text: delta });
      }
    });
    await deps.store.updateMessage(workspace.id, threadId, assistant.id, result.text);
    event(res, "done", {
      messageId: assistant.id,
      usage: { input: result.usage.input, output: result.usage.output }
    });
  } catch (error) {
    const apiError = toApiError(error);
    const content = streamed ? `${streamed}

> \u26A0\uFE0F ${apiError.message}` : `\u26A0\uFE0F ${apiError.message}`;
    await deps.store.updateMessage(workspace.id, threadId, assistant.id, content, true).catch(() => void 0);
    event(res, "error", apiError);
    event(res, "done", { messageId: assistant.id });
  } finally {
    res.end();
  }
}
function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}
function sendError(res, error) {
  const apiError = toApiError(error);
  send(res, statusOf(apiError.code), { error: apiError });
}
function event(res, name, data) {
  try {
    res.write(`event: ${name}
data: ${JSON.stringify(data)}

`);
  } catch {
  }
}
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1e6) throw new Error("E_BAD_REQUEST: \u8BF7\u6C42\u4F53\u8FC7\u5927");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("E_BAD_REQUEST: \u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
}
function allow(method, methods) {
  if (!methods.includes(method)) throw new Error(`E_BAD_REQUEST: \u4E0D\u652F\u6301 ${method}`);
}
function decode(value) {
  return decodeURIComponent(value);
}
function asText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function toApiError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const matched = /^(E_[A-Z_]+):\s*(.*)$/s.exec(raw);
  if (matched) return { code: matched[1], message: matched[2] || raw };
  if (process.env["DSH_ATLAS_DEBUG"]) console.warn("[atlas]", error);
  return { code: "E_INTERNAL", message: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF" };
}
function statusOf(code) {
  switch (code) {
    case "E_NOT_FOUND":
      return 404;
    case "E_AUTH":
      return 401;
    case "E_CONFLICT":
      return 409;
    case "E_BUDGET":
      return 413;
    case "E_UNSUPPORTED":
      return 501;
    case "E_MODEL":
      return 502;
    case "E_VALIDATION":
    case "E_BAD_REQUEST":
      return 400;
    default:
      return 500;
  }
}

// package.json
var package_default = {
  name: "dsh-atlas",
  version: "0.1.3",
  description: "\u628A\u5BF9\u8BDD\u957F\u6210\u4E00\u5F20\u5730\u56FE \xB7 A spatial workspace for long conversations, as a DeepSeek Harness plugin",
  type: "module",
  license: "MIT",
  main: "lib/host/index.js",
  exports: {
    ".": "./lib/host/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  files: [
    "lib",
    "cordis.patch.yml",
    "README.md",
    "LICENSE"
  ],
  engines: {
    node: ">=22.19.0"
  },
  dsh: {
    bundle: {
      patch: "./cordis.patch.yml"
    },
    client: {
      platform: "web",
      inject: [
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-renderer"
      ]
    }
  },
  scripts: {
    build: "node scripts/build.mjs",
    typecheck: "tsc --noEmit",
    smoke: "node tests/smoke.mjs",
    check: "npm run typecheck && npm run build && npm run smoke",
    "release:patch": "npm version patch --no-git-tag-version && npm run check",
    dev: "node scripts/build.mjs --watch"
  },
  dependencies: {
    "@deepseek-ai/dsh-home-paths": "0.2.1-rc.2"
  },
  peerDependencies: {
    "@deepseek-ai/cordis": "~4.0.5",
    react: "^18.2.0"
  },
  peerDependenciesMeta: {
    "@deepseek-ai/cordis": {
      optional: true
    },
    react: {
      optional: true
    }
  },
  devDependencies: {
    "@deepseek-ai/cordis": "~4.0.5",
    "@types/node": "^22.10.0",
    "@types/react": "~18.3.1",
    esbuild: "^0.25.0",
    react: "^18.2.0",
    typescript: "^5.7.0"
  }
};

// src/host/update.ts
var DEFAULT_REPO = "nononeundertsand/DSH-Atlas";
var DEFAULT_BRANCH = "main";
var DEFAULT_INTERVAL = 6 * 60 * 60 * 1e3;
var UpdateChecker = class {
  constructor(config = {}) {
    this.config = config;
  }
  cached;
  pending;
  get currentVersion() {
    return package_default.version;
  }
  async check(force = false) {
    const repo = validRepo(this.config.updateRepo);
    const url = `https://github.com/${repo}`;
    const disabled = this.config.checkUpdates === false;
    if (disabled) {
      return {
        currentVersion: package_default.version,
        updateAvailable: false,
        url,
        checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
        error: "disabled"
      };
    }
    const interval = this.config.updateIntervalMs ?? DEFAULT_INTERVAL;
    if (!force && this.cached && Date.now() - this.cached.at < interval) return this.cached.info;
    if (force && this.cached && Date.now() - this.cached.at < 6e4) return this.cached.info;
    if (this.pending) return this.pending;
    this.pending = this.fetchLatest(repo, url).catch((error) => ({
      currentVersion: package_default.version,
      updateAvailable: false,
      url,
      checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
      error: error instanceof Error ? error.message : "\u66F4\u65B0\u68C0\u67E5\u5931\u8D25"
    })).then((info) => {
      this.cached = { at: Date.now(), info };
      this.pending = void 0;
      return info;
    });
    return this.pending;
  }
  async fetchLatest(repo, url) {
    const branch = validBranch(this.config.updateBranch);
    const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
    const candidates = [
      {
        url: `https://api.github.com/repos/${repo}/contents/package.json?ref=${encodedBranch}`,
        accept: "application/vnd.github.raw+json"
      },
      {
        url: `https://raw.githubusercontent.com/${repo}/${encodedBranch}/package.json`,
        accept: "application/json"
      }
    ];
    let lastError;
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate.url, {
          headers: { accept: candidate.accept, "user-agent": "dsh-atlas" },
          signal: AbortSignal.timeout(6e3)
        });
        if (!response.ok) {
          lastError = new Error(`GitHub \u8FD4\u56DE ${response.status}`);
          continue;
        }
        const remote = await response.json();
        if (typeof remote.version !== "string") {
          lastError = new Error("\u8FDC\u7AEF package.json \u6CA1\u6709 version");
          continue;
        }
        return {
          currentVersion: package_default.version,
          latestVersion: remote.version,
          updateAvailable: compareVersions(remote.version, package_default.version) > 0,
          url,
          checkedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("\u66F4\u65B0\u68C0\u67E5\u5931\u8D25");
  }
};
function compareVersions(left, right) {
  const [leftCore, leftPre] = splitVersion(left);
  const [rightCore, rightPre] = splitVersion(right);
  for (let index = 0; index < 3; index++) {
    const diff = (leftCore[index] ?? 0) - (rightCore[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (!leftPre && rightPre) return 1;
  if (leftPre && !rightPre) return -1;
  if (!leftPre && !rightPre) return 0;
  return leftPre.localeCompare(rightPre);
}
function splitVersion(version) {
  const clean = version.trim().replace(/^v/i, "");
  const [core = "0", ...pre] = clean.split("-");
  return [core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre.join("-")];
}
function validRepo(repo) {
  return repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : DEFAULT_REPO;
}
function validBranch(branch) {
  return branch && /^[A-Za-z0-9_./-]+$/.test(branch) ? branch : DEFAULT_BRANCH;
}

// src/host/index.ts
var inject = ["webServer", "llm", "agentDefaultModel"];
function apply(ctx, config = {}) {
  const store = new AtlasStore(config.dataDir);
  const model = new AtlasModel(ctx.llm, config, () => ctx.agentDefaultModel?.currentSelection());
  const updates = new UpdateChecker(config);
  const router = createAtlasRouter({
    store,
    model,
    dataDir: store.location,
    modelHint: config.model ?? "auto",
    checkUpdate: (force) => updates.check(force)
  });
  ctx.effect(
    () => ctx.webServer.register({ kind: "prefix", path: ATLAS_BASE, handler: router }),
    "dsh-atlas: routes"
  );
  console.log(`[atlas] ready \xB7 workspaces: ${store.location}`);
}
export {
  apply,
  inject
};
//# sourceMappingURL=index.js.map
