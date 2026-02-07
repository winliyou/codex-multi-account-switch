# opencode-codex-auto-switch

OpenCode 插件，支持**多个 ChatGPT Plus/Pro 账号自动轮换**登录 Codex 后端。遇到速率限制 (429) 或用量耗尽时自动切换到下一个健康账号，无需手动干预。

## 功能特性

- **多账号池管理** — 通过 OAuth 逐个添加 ChatGPT 账号，组成轮换池
- **自动故障转移** — 遇到 429 / 503 / usage_limit_reached 时自动切换账号并重试
- **健康评分** — 基于成功/失败记录动态评估每个账号的可用性，自动回避低分账号
- **令牌桶限流** — 客户端侧预判速率限制，减少无效请求
- **多种选择策略** — 支持 `sticky`、`round-robin`、`hybrid` 三种账号选择模式
- **Token 自动刷新** — 每次请求前检查 access token 有效期，过期自动 refresh
- **Codex API 转换** — 与 `opencode-openai-codex-auth` 相同的请求/响应转换逻辑
- **零侵入** — 基于 OpenCode 插件机制，不修改任何 OpenCode 核心文件

## 前提条件

- [OpenCode](https://opencode.ai/) >= 1.1.x
- 至少一个 ChatGPT Plus 或 Pro 订阅账号
- Node.js >= 20

## 安装

### 本地安装（推荐用于开发）

克隆并构建：

```bash
git clone <repo-url> opencode-codex-auto-switch
cd opencode-codex-auto-switch
npm install
npm run build
```

在 `~/.config/opencode/opencode.json` 中添加插件（使用 `file://` 协议指向构建产物）：

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/opencode-codex-auto-switch/dist/index.js"
  ]
}
```

### npm 安装（发布后可用）

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "opencode-codex-auto-switch"
  ]
}
```

## 配置

### Provider 配置

插件使用 `openai` 作为 provider ID，直接在 `opencode.json` 的 `provider.openai` 段配置模型：

```jsonc
{
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "reasoningSummary": "auto",
        "textVerbosity": "medium",
        "include": ["reasoning.encrypted_content"],
        "store": false
      },
      "models": {
        "gpt-5.1-codex": {
          "name": "GPT 5.1 Codex",
          "limit": { "context": 272000, "output": 128000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
        // ... 其他模型
      }
    }
  }
}
```

### 插件配置（可选）

创建 `~/.opencode/codex-switch-config.json`：

```json
{
  "codexMode": true,
  "strategy": "hybrid",
  "debug": false
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `codexMode` | boolean | `true` | 启用 Codex 模式（注入 Codex 系统提示词，替换 OpenCode 默认提示词） |
| `strategy` | string | `"hybrid"` | 账号选择策略，见下方说明 |
| `debug` | boolean | `false` | 是否输出调试日志 |

### 账号选择策略

| 策略 | 行为 |
|------|------|
| `sticky` | 尽可能复用当前账号，仅在失败时切换 |
| `round-robin` | 按顺序逐个使用账号 |
| `hybrid` | **推荐** — 综合考虑健康评分、令牌桶余量和最近使用时间，选择最优账号 |

### 环境变量

| 变量 | 说明 |
|------|------|
| `CODEX_MODE` | 覆盖 codexMode 配置（`1` 启用 / `0` 禁用） |
| `DEBUG_CODEX_SWITCH` | 设为 `1` 开启调试日志 |
| `ENABLE_PLUGIN_REQUEST_LOGGING` | 设为 `1` 将请求详情写入 `~/.opencode/logs/codex-auto-switch/` |

## 使用

### 添加账号

```bash
opencode auth login
```

选择 **openai**，然后在 Login method 中选择：

- **ChatGPT Plus/Pro (Auto-Switch Multi-Account)** — 自动打开浏览器完成 OAuth 登录
- **ChatGPT Plus/Pro (Manual URL Paste - Multi-Account)** — 手动复制粘贴回调 URL

每次执行 `opencode auth login` 并完成认证，就会**向轮换池中添加一个新账号**。多次执行可以添加多个不同的 ChatGPT 账号。

### 自动引导

如果你之前通过 `opencode-openai-codex-auth` 登录过，插件启动时会自动从 OpenCode 已存储的 OAuth 凭据中导入第一个账号，无需重新登录。

### 日常使用

添加完账号后正常使用 OpenCode 即可。插件在后台自动完成：

- 选择最优账号发送请求
- 刷新过期的 access token
- 遇到限速时切换账号并重试（最多 3 次）
- 更新健康评分和使用记录

### 数据存储

| 文件 | 路径 | 说明 |
|------|------|------|
| 账号数据 | `~/.opencode/codex-switch-accounts.json` | 所有账号的 token 和状态 |
| 插件配置 | `~/.opencode/codex-switch-config.json` | 可选的自定义配置 |
| 调试日志 | `~/.opencode/logs/codex-auto-switch/` | 仅在开启日志时生成 |

> 账号数据文件包含敏感的 OAuth token，请勿提交到版本控制。插件会自动在同目录维护 `.gitignore`。

## 与 opencode-openai-codex-auth 的关系

本插件基于 [opencode-openai-codex-auth](https://github.com/nicekid1/opencode-openai-codex-auth) 的 Codex API 转换逻辑，在此基础上增加了多账号管理和自动轮换能力。

两个插件使用相同的 provider ID (`openai`)，**同一时间只能启用一个**。在 `opencode auth login` 中通过 auth method 的 label 区分：

| 插件 | Auth Label |
|------|-----------|
| opencode-openai-codex-auth | ChatGPT Plus/Pro |
| **opencode-codex-auto-switch** | ChatGPT Plus/Pro **(Auto-Switch Multi-Account)** |

切换时只需在 `opencode.json` 的 `plugin` 数组中注释/取消注释对应的插件即可。

## 速率限制处理

当某个账号触发限速时，插件会：

- 根据错误类型分类原因（`RATE_LIMIT_EXCEEDED` / `USAGE_LIMIT_REACHED` / `SERVER_ERROR`）
- 为该账号设置冷却期（429 → 30s，quota 耗尽 → 1min/5min/30min 递增，503 → 20s）
- 立即切换到下一个健康账号重试
- 更新健康评分（限速 -10 分，失败 -20 分，成功 +1 分，每小时自动回复 2 分）

## 开发

```bash
npm install        # 安装依赖
npm run build      # 编译 TypeScript
npm run typecheck  # 仅类型检查
```

## License

MIT
