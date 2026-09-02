$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_lib.ps1')

Import-DotEnv
Initialize-RuntimeDirectories
Stop-TrackedProcesses -Quiet

$node = (Get-Command node).Source
$coreDir = Join-Path $script:RepoRoot 'MemoryCore'
$knowledgeDir = Join-Path $script:RepoRoot 'MemoryKnowledge'
$panelDir = Join-Path $script:RepoRoot 'MemoryPanel'
$proxyDir = Join-Path $script:RepoRoot 'MemoryProxy'

$corePort = Get-EnvValue 'MEMORY_CORE_PORT' '8420'
$panelPort = Get-EnvValue 'PANEL_PORT' '8125'
$knowledgePort = Get-EnvValue 'KNOWLEDGE_PORT' '8424'
$proxyPort = Get-EnvValue 'PROXY_PORT' '8096'

$coreUrl = "http://127.0.0.1:$corePort"
$panelUrl = "http://127.0.0.1:$panelPort"
$knowledgeUrl = "http://127.0.0.1:$knowledgePort"
$proxyUrl = "http://127.0.0.1:$proxyPort"

$metadataConfigPath = Join-Path $script:ConfigDir 'metadata-instances.json'
$proxyConfigPath = Join-Path $script:ConfigDir 'proxy.yaml'
$proxyDbPath = Join-Path $script:DataDir 'proxy\proxy.db'

$metadataConfig = @{
    instances = @(
        @{
            id = 'default'
            name = 'Local source instance'
            gateway_endpoint = $coreUrl
            proxy_endpoint = $proxyUrl
            api_key = 'local'
        }
    )
} | ConvertTo-Json -Depth 4
Write-Utf8File $metadataConfigPath $metadataConfig

$upstreamUrl = ConvertTo-YamlScalar (Get-EnvValue 'PROXY_UPSTREAM_URL')
$upstreamKey = ConvertTo-YamlScalar (Get-EnvValue 'PROXY_UPSTREAM_API_KEY')
$coreYamlUrl = ConvertTo-YamlScalar $coreUrl
$proxyDbYamlPath = ConvertTo-YamlScalar '../data/proxy/proxy.db'
$proxyConfig = @"
server:
  host: 127.0.0.1
  port: $proxyPort
  forwardTimeoutMs: 600000

upstream:
  url: $upstreamUrl
  apiKey: $upstreamKey

log:
  file: ""
  level: info
  backend: console

tdai:
  enabled: true
  endpoint: $coreYamlUrl
  apiKey: local
  serviceId: default
  memory:
    enabled: true
    inject: true
    writeL0: true
    recallL1: true
    injectL2L3: true

skill:
  endpoint: $coreYamlUrl
  serviceToken: local
  serviceId: default

knowledge:
  enabled: true
  endpoint: $coreYamlUrl
  serviceToken: local
  serviceId: default

auth:
  enabled: true
  url: $coreYamlUrl
  timeoutMs: 5000

sessionInit:
  enabled: true
  maxRetries: 3
  injectAgentContext: true
  injectTaskContext: true
  headerAutoSelect:
    enabled: true
    teamHeader: x-team-id
    agentHeader: x-agent-id
    taskHeader: x-task-id
    onMismatch: form

injection:
  enabled: true
  injectors: [skill, knowledge, tdai-memory]

redis:
  enabled: false

storage:
  enabled: true
  backend: sqlite
  sqlite:
    dbPath: $proxyDbYamlPath

costGuard:
  enabled: false
"@
Write-Utf8File $proxyConfigPath $proxyConfig

try {
    Write-Info 'Starting MemoryCore'
    $coreProcess = Start-SourceProcess `
        'memory-core' `
        $coreDir `
        $node `
        @('--import', 'tsx', 'src/gateway/server.ts') `
        @{
            NODE_ENV = 'production'
            TDAI_GATEWAY_CONFIG = (Join-Path $script:DeployDir 'config\tdai-gateway.yaml')
            TDAI_GATEWAY_HOST = '127.0.0.1'
            TDAI_GATEWAY_PORT = $corePort
            TDAI_GATEWAY_API_KEY = ''
            TDAI_DATA_DIR = (Join-Path $script:DataDir 'memory-core')
            LOG_PATH = $script:LogDir
            TDAI_LLM_BASE_URL = (Get-EnvValue 'MEMORY_LLM_BASE_URL')
            TDAI_LLM_API_KEY = (Get-EnvValue 'MEMORY_LLM_API_KEY')
            TDAI_LLM_MODEL = (Get-EnvValue 'MEMORY_LLM_MODEL')
        }
    Wait-SourceService 'memory-core' $coreProcess "$coreUrl/health" 90

    if (Test-Path -LiteralPath $script:AdminKeyFile -PathType Leaf) {
        $adminKey = (Get-Content -LiteralPath $script:AdminKeyFile -Raw).Trim()
    } else {
        $adminKey = New-RandomUserKey
    }
    $adminResult = Invoke-JsonRequest `
        "$coreUrl/v3/internal/meta/user/init-admin" `
        'Post' `
        @{ 'x-tdai-service-id' = 'default' } `
        @{ username = 'admin'; user_key = $adminKey }
    if ($adminResult.Status -eq 200) {
        Write-Utf8File $script:AdminKeyFile $adminKey
        Write-Ok "Admin user initialized. Key: $script:AdminKeyFile"
    } elseif ($adminResult.Status -eq 409 -and (Test-Path -LiteralPath $script:AdminKeyFile -PathType Leaf)) {
        Write-Ok 'Admin user already exists'
    } else {
        Write-Warn "Admin initialization returned HTTP $($adminResult.Status)"
    }

    Write-Info 'Starting MemoryKnowledge'
    $knowledgeProcess = Start-SourceProcess `
        'knowledge' `
        $knowledgeDir `
        $node `
        @('dist/server.mjs') `
        @{
            NODE_ENV = 'production'
            PORT = $knowledgePort
            API_PREFIX = '/v3'
            KNOWLEDGE_DATA_DIR = (Join-Path $script:DataDir 'knowledge')
            KNOWLEDGE_DB_PATH = (Join-Path $script:DataDir 'knowledge\knowledge.db')
            KNOWLEDGE_PUBLIC_BASE_URL = "$knowledgeUrl/v3"
            TMC_CALLBACK_URL = $panelUrl
            GIT_CONFIG_COUNT = '1'
            GIT_CONFIG_KEY_0 = 'core.longpaths'
            GIT_CONFIG_VALUE_0 = 'true'
            LLM_MODE = 'custom'
            LLM_PROTOCOL = (Get-EnvValue 'MEMORY_LLM_PROTOCOL' 'openai')
            LLM_PROVIDER = 'custom'
            LLM_BASE_URL = (Get-EnvValue 'MEMORY_LLM_BASE_URL')
            LLM_API_KEY = (Get-EnvValue 'MEMORY_LLM_API_KEY')
            LLM_MODEL = (Get-EnvValue 'MEMORY_LLM_MODEL')
            LOG_LEVEL = 'info'
        }
    Wait-SourceService 'knowledge' $knowledgeProcess "$knowledgeUrl/health" 90

    Write-Info 'Starting MemoryPanel'
    $panelProcess = Start-SourceProcess `
        'panel' `
        $panelDir `
        $node `
        @('dist/index.js') `
        @{
            NODE_ENV = 'production'
            HOST = '127.0.0.1'
            PORT = $panelPort
            UI_DIST_DIR = (Join-Path $panelDir 'web\dist')
            METADATA_INSTANCES_CONFIG = $metadataConfigPath
            KNOWLEDGE_SERVICE_URL = $knowledgeUrl
            KNOWLEDGE_LLM_BINDING_SYNC = '0'
            KNOWLEDGE_LLM_PROXY_BASE_URL = $proxyUrl
            TDAI_AGENT_TEMPLATE_DIR = (Join-Path $script:DataDir 'knowledge\agent-templates')
            LOG_LEVEL = 'info'
            LOG_FORMAT = 'pretty'
        }
    Wait-SourceService 'panel' $panelProcess "$panelUrl/health" 60

    Write-Info 'Starting MemoryProxy'
    $quotedProxyConfig = '"' + $proxyConfigPath + '"'
    $proxyProcess = Start-SourceProcess `
        'proxy' `
        $proxyDir `
        $node `
        @('--import', 'tsx/esm', 'src/index.ts', '--config', $quotedProxyConfig) `
        @{
            NODE_ENV = 'production'
            PROXY_DB_PATH = $proxyDbPath
        }
    Wait-SourceService 'proxy' $proxyProcess "$proxyUrl/health" 90
} catch {
    Stop-TrackedProcesses -Quiet
    throw
}

Write-Ok 'All source services are ready'
Write-ServiceEndpoints
Write-Host ''
Write-Host "Admin user key: $script:AdminKeyFile"
Write-Host "Process logs: $script:LogDir"
Write-Host 'Stop services: .\stop-all.ps1'
