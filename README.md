# dsh-model-garden

A searchable, sortable **model picker** for the [DeepSeek Harness](https://github.com/deepseek-ai) Web UI (`dsh web`). It replaces the native composer model seat with a table-style picker that adds everything the stock selector is missing:

![status](https://img.shields.io/badge/status-stable-brightgreen) [![npm](https://img.shields.io/npm/v/dsh-model-garden)](https://www.npmjs.com/package/dsh-model-garden) ![license](https://img.shields.io/badge/license-MIT-blue)

<table>
  <tr>
    <td width="50%"><img src="docs/model-garden-ui-1.png" alt="Model Garden picker with live cost"></td>
    <td width="50%"><img src="docs/model-garden-ui-2.png" alt="Model Garden session cost breakdown"></td>
  </tr>
</table>

## Features

- **🔍 Instant search** across model names and descriptions
- **📊 Sortable table columns** — click `Name`, `Ctx` or `Price` to sort asc/desc; a third click returns to the provider-grouped view
- **⭐ Favorites** — star models, toggle favorites-only from the table header; persisted in `localStorage`
- **🏠 Local tag** — providers are flagged *local* by their real endpoint (baseURL from settings: loopback / RFC1918 / LAN hostnames), never by price guesswork; the **Local** box next to the search input filters to them
- **▾ Collapsible provider groups** — collapse state is persisted per provider
- **🔄 Auto model-list update** — while the picker is mounted, the provider/model directory is re-loaded automatically every 5 minutes (configurable), so locally added models show up without reopening the panel
- **💰 Model prices** from [models.dev](https://models.dev) (the same source OpenCode uses), shown as `$input/$output` per 1M tokens, cached for 24 h. **Subscription routes** (all-zero cost in the catalog, e.g. coding-plan providers) resolve a *reference price* from their pay-as-you-go provider via `PROVIDER_ALIASES`, so plan models still show what their tokens would cost at API rates; only true **local** models stay unpriced
- **🧠 Context windows** — read live from the host `llm` service (adapter-owned data, works for **local** providers like llama.cpp / Ollama-style gateways too), with models.dev as fallback
- **🎚️ Reasoning effort picker** — models that support reasoning levels get a compact dropdown right next to the model name in the chat composer, styled and opening **exactly like the model picker** (same trigger pill, same floating menu surface, ✓ marks the active level, click outside / `Esc` / selecting closes it). Picking a model **always starts it at its strongest reasoning level**; the dropdown re-selects the current model with the chosen effort — no clutter inside the picker panel
- **💸 Live per-task usage & cost** — real provider-reported token usage (from the session log) is **always shown** while the panel is open (`in / out / cache`). Each model's usage is multiplied by **its own** (reference) price — properly attributed even when a session switched models mid-way — the same math OpenCode uses (`usage × price`, not a heuristic)
- **🧾 Session cost breakdown** — hover the `approx cost` figure for a popup **sized like the picker and parked parallel on its left (1 px gap)**: a **table-style breakdown** with per-model totals (steps, In/Out/Cache in their own columns, ≈ cost) and a **timestamped step table**. **Clickable column headers** work like Excel / the main list (asc → desc → off, ▲/▼ indicator) on both tables; **copy** the summary or **export the (sorted) step list as CSV** (Excel-ready). The invisible hover target spans the cost row all the way to its left edge. Attribution of each step to its model comes straight from the session log (`request/context` events); nothing extra is stored
- **📅 Tencent Cloud Token Plan balance badge** — while the picker is open, the cost row shows a **`本月积分剩余`** badge fed by the host's `/model-garden/tokenplan` route: quota − used from the TokenHub **主额度包** (`DescribeTokenPlan`), refreshed every 5 minutes and on open. The host signs Tencent Cloud API 3.0 (TC3) requests with **`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` from its own process env** — the browser never touches a credential. Without those env vars, or on any error, the badge simply stays hidden
- **🖱️ Detail tooltip** that opens *beside* the panel (never covers the list): description, price, context window, max output, reasoning efforts
- **🎨 Native look** — built entirely on the harness design tokens (`--dsw-alias-*`); the picker panel, the effort menu, the detail tooltip and the cost popup all share the same surface color and geometry, matching light & dark theme automatically

## How it works

The package is a **static profile plugin** with two halves:

| Half | File | Role |
|---|---|---|
| Client | `client.js` | Registers the `conversation.input.model` slot (priority `-1`, shadowing the native seat) and renders the picker |
| Host | `index.js` | Serves three same-origin JSON routes on the harness `webServer` service |

### Host endpoints

```
GET /model-garden/cost?session=<sessionId>
  → { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, steps }

GET /model-garden/cost-history?session=<sessionId>&limit=<n>
  → { steps: [ { time, provider, model, turn, step, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } ] (newest first, capped),
      models: [ { provider, model, steps, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } ],
      totalSteps }

GET /model-garden/catalog
  → { "provider::model": { local, context?, maxOutput? } }   (cached 10 min)

GET /model-garden/tokenplan
  → { enabled, plan?: { teamId, name, productType, status, stopReason,
      unit, totalQuota, totalUsed, cycleQuota,
      cycleStartTime, cycleEndTime, expireTime }, error? }
  Returns { enabled: false } when TENCENTCLOUD_SECRET_ID/KEY are absent;
  silently ignores errors so the picker never breaks.
```

The cost endpoint aggregates the real `usage` payloads of `assistant/message` events from the durable session log — no estimation. The cost-history endpoint additionally attributes each usage step to the model in effect: `assistant/message` events carry usage but not the model, so it tracks `request/context` (and `request/header`) events, which precede the request they describe with `{ provider, model }` — a single pass over the same in-memory events, no extra persistence. The catalog endpoint resolves `contextWindow` / `defaultMaxTokens` per model through the host `llm` service (`resolveModelInfo`), so local/self-hosted providers report their real limits.

## Changelog (fork)

### 0.6.5 (fork)
- **New:** Tencent Cloud Token Plan 月度积分余量徽标。Host 新增 `GET /model-garden/tokenplan`：用进程环境变量 `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` 做 TC3 签名，调 TokenHub `DescribeTokenPlanList` → `DescribeTokenPlan`，返回主额度包 quota/used；client 在成本行右侧渲染「积分 剩余 x/y」徽标，每 5 分钟轮询。无凭据/出错时静默隐藏，不影响原功能。

### 0.6.4
- Fix client seat crash on DeepSeek Harness `0.1.2-rc.1`: declare Cordis inject `remote` + `remote.session` (required by `modelDirectories.directoryFor`), and register the seat via `ctx.inject` instead of a one-shot `ctx.get("slots")`.

## Installation

One command — the official plugin CLI installs the package **and** mounts it (the package carries a `dsh.bundle.patch` layer, so the CLI automatically appends it to the profile's bundle stack):

```sh
dsh plugin --profile <profile> add dsh-model-garden
```

Installing your **local fork** (this repo) instead of the published package:

```sh
dsh plugin --profile <profile> add /Users/kodyqywang/dsh-model-garden
```

Then restart the DSH server and hard-refresh the browser (`Cmd/Ctrl+Shift+R`).

> The host half needs the web stack (`webServer` service). In minimal/TUI profiles without it the plugin stays inert by design — boot is never blocked.

> Upgrading from a manual install? Remove the old `model-garden` dependency and any manual `- insert:` row for it from your profile's `cordis.patch.yml` first — otherwise the plugin mounts twice.

### Verify

```bash
curl -s http://127.0.0.1:3080/model-garden/catalog | head -c 200
# → {"deepseek::deepseek-chat":{"local":false,"context":...}, ...}  (JSON, not HTML)
```

### Manual install (without the CLI)

If you manage the profile with plain npm: add the dependency, list `dsh-model-garden` in `dsh.profile.bundles` in the profile `package.json`, reinstall, restart. The bundle patch inside the package inserts the loader row for you — no `cordis.patch.yml` edit needed.

## Configuration

No configuration is required for the picker itself. The Token Plan balance badge additionally needs two env vars on the **harness host** process:

- `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` — a [Tencent Cloud API key](https://console.cloud.tencent.com/cam/capi) (NOT the lkeap `sk-*` key). Used only by the host to sign TokenHub `DescribeTokenPlanList`/`DescribeTokenPlan` calls; the browser never receives them. Missing or wrong credentials just hide the badge.

Tweakable constants live at the top of the respective file:

- **Auto model-list update interval** — `MODEL_LIST_REFRESH_MS` in `client.js` (default 5 min) controls how often the provider/model directory is reloaded while the picker is mounted.
- **Hidden provider routes** — `HIDDEN_PROVIDER_PREFIXES` in `client.js` (and `SKIP_PREFIXES` in `index.js`). Some plugins mirror providers as internal routes (e.g. a vision toolkit duplicating every provider as `vision-toolkit-<id>`); such prefixes are excluded from the picker and the catalog.
- **Price aliases** — `PROVIDER_ALIASES` / `MODEL_ALIASES` in `client.js` map DSH route ids to models.dev catalog ids. They serve two cases: renamed routes (`deepseek-official` → `deepseek`) and subscription routes whose catalog entry is all-zero (`kimi-for-coding` → `moonshotai`, `alibaba-tp` → `alibaba-cn`, `oneprovider` → `anthropic`), giving plan models their pay-as-you-go reference price.
- **Price cache TTL** — `PRICE_TTL` (default 24 h) and **catalog TTL** — `CATALOG_TTL` (default 10 min).

Favorites, collapsed providers and the price cache live in the browser's `localStorage` under `dsh.modelgarden.*`.

## Compatibility

Developed and tested against DeepSeek Harness `0.1.0-rc.8` (`@deepseek-ai/dsh-host-webserver`, `dsh-session`, `dsh-llm`, `dsh-client-ui-model-selection`); first released against `0.1.0-rc.6`. The client half is plain React via `window.__ModuleLoader__` — no build step, no dependencies.

## Credits

- Pricing data: [models.dev](https://models.dev) API (also used by [OpenCode](https://github.com/anomalyco/opencode))
- Design tokens & slot API: DeepSeek Harness

## License

[MIT](LICENSE)
