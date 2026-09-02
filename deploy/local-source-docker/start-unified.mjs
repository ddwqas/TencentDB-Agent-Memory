import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const env = (name, fallback = "") => process.env[name] ?? fallback;
const port = (name, fallback) => Number(env(name, String(fallback)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const corePort = port("MEMORY_CORE_PORT", 8420);
const panelPort = port("PANEL_PORT", 8125);
const knowledgePort = port("KNOWLEDGE_PORT", 8424);
const proxyPort = port("PROXY_PORT", 8096);
const coreGatewayKey = env("MEMORY_CORE_GATEWAY_API_KEY");
const adminUsername = env("MEMORY_CORE_ADMIN_USERNAME", "admin");
const adminKeyFile = env("MEMORY_CORE_ADMIN_KEY_FILE", "/data/admin-key");
const children = new Set();
let stopping = false;

const yamlString = (value) => JSON.stringify(String(value ?? ""));

function spawnService(name, command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error("[stack] " + name + " exited (code=" + (code ?? "null") + ", signal=" + (signal ?? "null") + ")");
      void stop(1);
    }
  });
  return child;
}

async function waitHealthy(name, url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log("[stack] " + name + " ready");
        return;
      }
    } catch {
      // 服务启动阶段连接失败是正常的。
    }
    await sleep(1000);
  }
  throw new Error(name + " 未在 " + timeoutMs / 1000 + "s 内就绪");
}

async function atomicWrite(path, content) {
  const temporary = path + ".tmp." + randomBytes(8).toString("hex");
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    if (error?.code !== "EBUSY") throw error;
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  }
}

async function readAdminKey() {
  await mkdir(dirname(adminKeyFile), { recursive: true });
  try {
    return (await readFile(adminKeyFile, "utf8")).trim();
  } catch {
    return "";
  }
}

async function initializeAdmin() {
  let key = await readAdminKey();
  const generated = !key;
  if (generated) key = "sk-mem-" + randomBytes(24).toString("base64url");

  const headers = {
    "content-type": "application/json",
    "x-tdai-service-id": "default",
  };
  if (coreGatewayKey) headers.authorization = "Bearer " + coreGatewayKey;
  const response = await fetch("http://127.0.0.1:" + corePort + "/v3/internal/meta/user/init-admin", {
    method: "POST",
    headers,
    body: JSON.stringify({ username: adminUsername, user_key: key }),
  });

  if (response.status === 200) {
    await atomicWrite(adminKeyFile, key + "\n");
    console.log("[stack] admin key 已保存到 " + adminKeyFile);
  } else if (response.status === 409 && !generated) {
    console.log("[stack] admin 用户已存在，复用已有 admin key");
  } else if (response.status === 409) {
    throw new Error("admin 用户已存在，但没有可用的 admin key；请挂载旧 key 或清空数据后重新启动");
  } else {
    throw new Error("init-admin 失败（HTTP " + response.status + "）：" + await response.text());
  }
}

async function writeConfigs() {
  await mkdir("/data/config", { recursive: true });
  await mkdir("/opt/tdai/panel/config", { recursive: true });

  const memoryBaseUrl = env("MEMORY_LLM_BASE_URL");
  const memoryApiKey = env("MEMORY_LLM_API_KEY");
  const memoryModel = env("MEMORY_LLM_MODEL");
  const memoryProtocol = env("MEMORY_LLM_PROTOCOL", "openai");

  const coreYaml = [
    "deployMode: standalone",
    "stateBackend: local",
    "server:",
    "  port: " + corePort,
    "  host: 0.0.0.0",
    "data:",
    "  baseDir: /data/tdai-memory",
    "llm:",
    "  baseUrl: " + yamlString(memoryBaseUrl),
    "  apiKey: " + yamlString(memoryApiKey),
    "  model: " + yamlString(memoryModel),
    "  protocol: " + memoryProtocol,
    "  maxTokens: 32000",
    "  timeoutMs: 300000",
    "memory:",
    "  promptMode: " + env("MEMORY_PROMPT_MODE", "chat"),
    "  capture: { enabled: true }",
    "  extraction:",
    "    enabled: true",
    "    enableDedup: true",
    "    maxMemoriesPerSession: 20",
    "  persona:",
    "    triggerEveryN: 50",
    "    maxScenes: 15",
    "  pipeline:",
    "    everyNConversations: 5",
    "    enableWarmup: true",
    "    l1IdleTimeoutSeconds: 600",
    "    l2DelayAfterL1Seconds: 90",
    "    l2MinIntervalSeconds: 900",
    "    l2MaxIntervalSeconds: 3600",
    "  recall:",
    "    enabled: true",
    "    maxResults: 5",
    "    scoreThreshold: 0.3",
    "    strategy: hybrid",
    "    timeoutMs: 5000",
    "  storeBackend: sqlite",
    "  embedding:",
    "    provider: none",
    "skill:",
    "  enabled: true",
    "  routing:",
    "    mode: bm25",
    "    searchTopK: 20",
    "  extraction:",
    "    enabled: true",
    "    maxIterations: 16",
    "    queue:",
    "      backend: local",
    "      keyPrefix: tdai",
    "      resultTtlSeconds: 86400",
    "      lockTtlMs: 600000",
    "      maxRetries: 2",
    "      retryBackoffsMs: [5000, 15000]",
    "  resources:",
    "    maxResourceSizeBytes: 5000000",
    "",
  ].join("\n");
  await writeFile("/data/config/tdai-gateway.yaml", coreYaml, "utf8");

  const knowledgePublicUrl = env("KNOWLEDGE_PUBLIC_BASE_URL", "http://127.0.0.1:" + knowledgePort + "/v3");
  const instanceKey = coreGatewayKey || "local";
  await writeFile(
    "/opt/tdai/panel/config/metadata-instances.json",
    JSON.stringify({
      instances: [{
        id: "default",
        name: "default",
        gateway_endpoint: "http://127.0.0.1:" + corePort,
        proxy_endpoint: "http://127.0.0.1:" + proxyPort,
        api_key: instanceKey,
      }],
    }, null, 2) + "\n",
    "utf8",
  );

  const proxyYaml = [
    "server:",
    "  host: 0.0.0.0",
    "  port: " + proxyPort,
    "  forwardTimeoutMs: 600000",
    "upstream:",
    "  url: " + yamlString(env("PROXY_UPSTREAM_URL")),
    "  apiKey: " + yamlString(env("PROXY_UPSTREAM_API_KEY")),
    "log:",
    "  file: \"\"",
    "  level: info",
    "  backend: console",
    "tdai:",
    "  enabled: true",
    "  endpoint: " + yamlString("http://127.0.0.1:" + corePort),
    "  apiKey: " + yamlString(instanceKey),
    "  serviceId: default",
    "  memory:",
    "    enabled: true",
    "    inject: true",
    "    writeL0: true",
    "    recallL1: true",
    "    injectL2L3: true",
    "skill:",
    "  endpoint: " + yamlString("http://127.0.0.1:" + corePort),
    "  serviceToken: " + yamlString(instanceKey),
    "auth:",
    "  enabled: true",
    "  url: " + yamlString("http://127.0.0.1:" + corePort),
    "  timeoutMs: 5000",
    "sessionInit:",
    "  enabled: true",
    "  maxRetries: 3",
    "  injectAgentContext: true",
    "  injectTaskContext: true",
    "  headerAutoSelect:",
    "    enabled: true",
    "    teamHeader: x-team-id",
    "    agentHeader: x-agent-id",
    "    taskHeader: x-task-id",
    "    onMismatch: form",
    "costGuard:",
    "  enabled: false",
    "injection:",
    "  enabled: true",
    "  injectors: [skill, knowledge, tdai-memory]",
    "redis:",
    "  enabled: false",
    "",
  ].join("\n");
  await writeFile("/data/config/proxy.yaml", proxyYaml, "utf8");

  return {
    memoryBaseUrl,
    memoryApiKey,
    memoryModel,
    memoryProtocol,
    knowledgePublicUrl,
  };
}

async function start() {
  const config = await writeConfigs();

  spawnService("memory-core", "node", ["--import", "tsx", "src/gateway/server.ts"], "/app", {
    TDAI_GATEWAY_CONFIG: "/data/config/tdai-gateway.yaml",
    TDAI_GATEWAY_HOST: "0.0.0.0",
    TDAI_GATEWAY_PORT: String(corePort),
    TDAI_DATA_DIR: "/data/tdai-memory",
    TDAI_GATEWAY_API_KEY: coreGatewayKey,
  });
  await waitHealthy("memory-core", "http://127.0.0.1:" + corePort + "/health");
  await initializeAdmin();

  spawnService("knowledge", "node", ["dist/server.mjs"], "/opt/tdai/knowledge", {
    PORT: String(knowledgePort),
    API_PREFIX: "/v3",
    KNOWLEDGE_DATA_DIR: "/data/knowledge",
    KNOWLEDGE_DB_PATH: "/data/knowledge/knowledge.db",
    KNOWLEDGE_PUBLIC_BASE_URL: config.knowledgePublicUrl,
    TMC_CALLBACK_URL: "http://127.0.0.1:" + panelPort,
    LLM_MODE: "custom",
    LLM_PROTOCOL: config.memoryProtocol,
    LLM_PROVIDER: "custom",
    LLM_BASE_URL: config.memoryBaseUrl,
    LLM_API_KEY: config.memoryApiKey,
    LLM_MODEL: config.memoryModel,
    LOG_LEVEL: env("LOG_LEVEL", "info"),
  });
  await waitHealthy("knowledge", "http://127.0.0.1:" + knowledgePort + "/health");

  spawnService("panel", "node", ["dist/index.js"], "/opt/tdai/panel", {
    HOST: "0.0.0.0",
    PORT: String(panelPort),
    UI_DIST_DIR: "/opt/tdai/panel/web/dist",
    METADATA_INSTANCES_CONFIG: "/opt/tdai/panel/config/metadata-instances.json",
    KNOWLEDGE_SERVICE_URL: "http://127.0.0.1:" + knowledgePort,
    KNOWLEDGE_LLM_BINDING_SYNC: "0",
    KNOWLEDGE_LLM_PROXY_BASE_URL: "http://127.0.0.1:" + proxyPort,
    LOG_LEVEL: env("LOG_LEVEL", "info"),
    LOG_FORMAT: env("LOG_FORMAT", "json"),
  });
  await waitHealthy("panel", "http://127.0.0.1:" + panelPort + "/health");

  spawnService("proxy", "node", ["--import", "tsx/esm", "src/index.ts", "--config", "/data/config/proxy.yaml"], "/opt/tdai/proxy", {
    PROXY_DB_PATH: "/data/tdai-memory-proxy/proxy.db",
  });
  await waitHealthy("proxy", "http://127.0.0.1:" + proxyPort + "/health");

  console.log("[stack] ready: core=" + corePort + ", panel=" + panelPort + ", knowledge=" + knowledgePort + ", proxy=" + proxyPort);
  await new Promise(() => {});
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  await sleep(1500);
  for (const child of children) child.kill("SIGKILL");
  process.exit(code);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

start().catch(async (error) => {
  console.error("[stack] 启动失败：" + (error instanceof Error ? error.message : String(error)));
  await stop(1);
});
