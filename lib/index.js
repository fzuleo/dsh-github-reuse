/**
 * dsh-github-reuse
 *
 * 让 agent 在线检索、体检、读取 GitHub 上的开源项目，用成熟实现来拼装功能，
 * 而不是从零手写。全程只走 HTTP（GitHub REST API + raw 文件通道），
 * **不 clone 任何仓库**，因此几乎不占磁盘。
 *
 * 注册内容：
 *   - 工具：github_search / github_inspect / github_tree_and_manifest / github_read
 *   - 系统提示词段：复用优先策略与选型硬门槛
 *   - 技能：oss-reuse（完整工作流）
 *
 * 可选配置（profile 的 cordis.patch.yml 里给 id: github-reuse 加 config）：
 *   token: GitHub Personal Access Token（也可用环境变量 GITHUB_TOKEN / GH_TOKEN）
 *   timeoutMs: 单次 HTTP 超时，默认 20000
 *   maxOutputChars: 单个工具输出上限，默认 16000
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'github-reuse'
export const inject = ['tools']

const API_ROOT = 'https://api.github.com'
const RAW_ROOT = 'https://raw.githubusercontent.com'
const USER_AGENT = 'dsh-github-reuse'
const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_OUTPUT = 16000
const DEFAULT_RETRIES = 3
const DEFAULT_CONCURRENCY = 4
const API_TTL_MS = 5 * 60 * 1000
const RAW_TTL_MS = 10 * 60 * 1000

/** 简单的进程内缓存：同一轮里反复查同一个仓库不会重复打 API。 */
const cache = new Map()

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function readSettings(config) {
  const cfg = config ?? {}
  const env = process.env
  const token = String(
    cfg.token ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_API_TOKEN ?? '',
  ).trim()
  const timeoutMs =
    Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputChars =
    Number.isFinite(cfg.maxOutputChars) && cfg.maxOutputChars > 0
      ? cfg.maxOutputChars
      : DEFAULT_MAX_OUTPUT
  const retries =
    Number.isFinite(cfg.retries) && cfg.retries > 0 ? clampInt(cfg.retries, 1, 5, DEFAULT_RETRIES) : DEFAULT_RETRIES
  const concurrency =
    Number.isFinite(cfg.concurrency) && cfg.concurrency > 0
      ? clampInt(cfg.concurrency, 1, 8, DEFAULT_CONCURRENCY)
      : DEFAULT_CONCURRENCY
  return { token, timeoutMs, maxOutputChars, retries, concurrency }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字符，需要更多内容请缩小范围或分段读取）`
}

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

function fmtCount(n) {
  if (!Number.isFinite(n)) return '?'
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function fmtDate(iso) {
  if (typeof iso !== 'string' || iso.length < 10) return '未知'
  return iso.slice(0, 10)
}

function fmtSizeMb(kb) {
  if (!Number.isFinite(kb) || kb <= 0) return '未知'
  const mb = kb / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`
}

function daysSince(iso) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return Infinity
  return Math.floor((Date.now() - t) / 86400000)
}

function parseRepo(input) {
  const raw = String(input ?? '').trim()
  const m =
    raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ??
    raw.match(/github\.com\/([\w.-]+)\/([\w.-]+)/)
  if (!m) throw new Error(`仓库格式应为 owner/name，收到：${JSON.stringify(raw)}`)
  const owner = m[1]
  const repo = m[2].replace(/[#?].*$/, '')
  return { owner, repo, slug: `${owner}/${repo}` }
}

function rateLimitNote(res, token) {
  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  const bits = []
  if (remaining !== null) bits.push(`剩余配额 ${remaining}`)
  if (Number.isFinite(reset) && reset > 0) {
    const when = new Date(reset * 1000)
    const mins = Math.max(0, Math.round((when.getTime() - Date.now()) / 60000))
    bits.push(`约 ${mins} 分钟后（${when.toLocaleTimeString('zh-CN', { hour12: false })}）重置`)
  }
  const head = `GitHub API 返回 HTTP ${res.status}（${res.statusText || '无说明'}）`
  const detail = bits.length > 0 ? `；${bits.join('，')}` : ''
  const advice = token
    ? '；当前已配置 token，若仍被限流可稍后重试。'
    : '；当前为匿名调用（核心 API 60 次/小时、搜索 10 次/分钟）。' +
      '可先用 github_read / github_tree_and_manifest（走 raw 通道，不受此限制）继续工作，' +
      '或配置 GITHUB_TOKEN 提升到 5000 次/小时。'
  return `${head}${detail}${advice}`
}

function permanentError(message) {
  const error = new Error(message)
  error.permanent = true
  return error
}

async function httpText(url, { settings, signal, accept, ttlMs, timeoutMs }) {
  const hit = cache.get(url)
  if (hit && hit.expiresAt > Date.now()) return hit.body

  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : settings.timeoutMs
  const attempts = Number.isFinite(settings.retries) && settings.retries > 0 ? settings.retries : DEFAULT_RETRIES
  const headers = { 'user-agent': USER_AGENT, accept: accept ?? 'application/vnd.github+json' }
  if (settings.token) headers.authorization = `Bearer ${settings.token}`

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw permanentError('请求已被取消')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), budget)
    const forwardAbort = () => controller.abort(signal?.reason)
    if (signal) signal.addEventListener('abort', forwardAbort, { once: true })
    try {
      const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' })
      const body = await res.text()
      if (!res.ok) {
        if (res.status === 404) throw permanentError(`GitHub 上不存在该资源（HTTP 404）：${url}`)
        if (res.status === 401) {
          throw permanentError('GitHub token 无效或已过期（HTTP 401），请检查插件配置 / GITHUB_TOKEN。')
        }
        if (res.status === 403 || res.status === 429) throw permanentError(rateLimitNote(res, settings.token))
        if (res.status >= 500 && attempt < attempts) {
          lastError = new Error(`GitHub 服务端错误 HTTP ${res.status}（第 ${attempt} 次，将重试）`)
        } else {
          throw permanentError(`GitHub 请求失败：HTTP ${res.status} ${res.statusText || ''}`.trim())
        }
      } else {
        if (ttlMs) cache.set(url, { body, expiresAt: Date.now() + ttlMs })
        if (cache.size > 400) {
          for (const [key, value] of cache) {
            if (value.expiresAt <= Date.now()) cache.delete(key)
          }
        }
        return body
      }
    } catch (error) {
      if (error?.permanent) throw error
      lastError = error
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', forwardAbort)
    }
    if (attempt < attempts) {
      const wait = 400 * attempt
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  const reason = lastError?.cause?.code ?? lastError?.message ?? '未知错误'
  throw new Error(
    `GitHub 请求失败（已重试 ${attempts} 次）：${reason}。若持续失败，说明本机到 GitHub 的网络不通，可稍后重试。`,
  )
}

async function apiJson(url, options) {
  const text = await httpText(url, { ...options, ttlMs: options.ttlMs ?? API_TTL_MS })
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`GitHub API 返回了非 JSON 内容：${clip(text, 200)}`)
  }
}

async function rawText(slug, path, ref, options) {
  const clean = String(path ?? '').replace(/^\/+/, '')
  const url = `${RAW_ROOT}/${slug}/${encodeURIComponent(ref || 'HEAD')}/${clean}`
  return httpText(url, { ...options, accept: 'text/plain', ttlMs: options.ttlMs ?? RAW_TTL_MS })
}

async function rawTextOrNull(slug, path, ref, options) {
  try {
    return await rawText(slug, path, ref, options)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// github_search
// ---------------------------------------------------------------------------

function buildSearchQuery(args) {
  const parts = [String(args.query ?? '').trim()]
  if (args.minStars !== undefined) parts.push(`stars:>=${clampInt(args.minStars, 0, 5_000_000, 0)}`)
  if (args.language) parts.push(`language:${String(args.language).replace(/\s+/g, '-')}`)
  if (args.license) parts.push(`license:${String(args.license).toLowerCase()}`)
  if (args.pushedWithinDays) {
    const days = clampInt(args.pushedWithinDays, 1, 3650, 365)
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    parts.push(`pushed:>=${since}`)
  }
  if (args.includeArchived !== true) parts.push('archived:false')
  if (args.includeForks !== true) parts.push('fork:false')
  if (args.topic) parts.push(`topic:${String(args.topic).trim()}`)
  return parts.filter(Boolean).join(' ')
}

function formatSearchResult(payload, query, perPage, settings) {
  const items = Array.isArray(payload?.items) ? payload.items : []
  const total = Number(payload?.total_count ?? 0)
  if (items.length === 0) {
    return [
      `没有匹配的仓库。查询式：\`${query}\``,
      '建议：放宽条件（去掉 language / license 限制、调低 minStars、把关键词换成更通用的领域词），或换英文关键词再试。',
    ].join('\n\n')
  }
  const header = `GitHub 搜索：\`${query}\`\n共 ${fmtCount(total)} 个匹配，返回前 ${items.length} 个。`
  const blocks = items.map((item, index) => {
    const slug = item.full_name
    const license = item.license?.spdx_id ?? item.license?.name ?? '无 license'
    const topics = Array.isArray(item.topics) && item.topics.length > 0 ? item.topics.slice(0, 6).join(', ') : ''
    const lines = [
      `${index + 1}. ${slug} — ★${fmtCount(item.stargazers_count)} · ${item.language ?? '语言未知'} · ${license} · 最近推送 ${fmtDate(item.pushed_at)} · 体积 ${fmtSizeMb(item.size)}${item.archived ? ' · 已归档' : ''}`,
      `   ${item.html_url}`,
      `   ${oneLine(item.description ?? '无描述', 180)}`,
    ]
    if (topics) lines.push(`   标签：${topics}`)
    if (Number.isFinite(item.open_issues_count)) {
      lines.push(`   开放 issue/PR：${fmtCount(item.open_issues_count)} · 创建于 ${fmtDate(item.created_at)}`)
    }
    return lines.join('\n')
  })
  const footer = [
    '下一步：对候选用 github_inspect 做体检（活跃度 / 许可证 / 体积 / 依赖），再用 github_tree_and_manifest 与 github_read 确认依赖与真实 API 用法。',
    settings.token ? '' : '（匿名配额有限，若已耗尽请稍后重试或配置 GITHUB_TOKEN。）',
  ]
    .filter(Boolean)
    .join('\n')
  return `${header}\n\n${blocks.join('\n\n')}\n\n${footer}`
}

async function runSearch(args, exec, settings) {
  const perPage = clampInt(args.maxResults, 1, 20, 8)
  const query = buildSearchQuery(args)
  const params = new URLSearchParams({ q: query, per_page: String(perPage) })
  const sort = String(args.sort ?? 'best-match')
  if (sort === 'stars') {
    params.set('sort', 'stars')
    params.set('order', 'desc')
  } else if (sort === 'updated') {
    params.set('sort', 'updated')
    params.set('order', 'desc')
  }
  const payload = await apiJson(`${API_ROOT}/search/repositories?${params.toString()}`, {
    settings,
    signal: exec.signal,
  })
  return formatSearchResult(payload, query, perPage, settings)
}

// ---------------------------------------------------------------------------
// github_inspect
// ---------------------------------------------------------------------------

function manifestCountsFromPackageJson(text) {
  try {
    const pkg = JSON.parse(text)
    const dep = Object.keys(pkg.dependencies ?? {})
    const dev = Object.keys(pkg.devDependencies ?? {})
    const peer = Object.keys(pkg.peerDependencies ?? {})
    return {
      ok: true,
      name: pkg.name,
      version: pkg.version,
      dep,
      dev,
      peer,
    }
  } catch {
    return { ok: false }
  }
}

function healthVerdict({ pushedAt, archived, license, sizeKb, depCount }) {
  const idle = daysSince(pushedAt)
  const notes = []
  if (archived) notes.push('⚠️ 仓库已归档，不再维护')
  if (idle <= 180) notes.push(`✅ 活跃（最近 ${idle} 天内仍有推送）`)
  else if (idle <= 365) notes.push(`🟡 一年内还有推送（${idle} 天前）`)
  else if (Number.isFinite(idle)) notes.push(`⚠️ 已 ${idle} 天无推送，属"停更/低维护"`)
  if (!license || license === 'NOASSERTION') notes.push('⚠️ 未识别到明确许可证，商用前必须人工确认')
  else notes.push(`✅ 许可证：${license}`)
  if (Number.isFinite(sizeKb) && sizeKb > 51200) notes.push('⚠️ 仓库体积 > 50 MB，不要 clone，用包管理器装或用 raw 读文件')
  if (Number.isFinite(depCount)) {
    notes.push(depCount <= 10 ? `✅ 运行时依赖 ${depCount} 个，集成成本低` : `🟡 运行时依赖 ${depCount} 个，注意体积与冲突`)
  }
  return notes
}

async function runInspect(args, exec, settings) {
  const { slug } = parseRepo(args.repo)
  const wantsReadme = args.includeReadme !== false
  const out = []

  let repo = null
  let degraded = ''
  try {
    repo = await apiJson(`${API_ROOT}/repos/${slug}`, { settings, signal: exec.signal })
  } catch (error) {
    degraded = `⚠️ 无法通过 API 取仓库元数据：${error.message}\n（以下结论基于 raw 文件通道，可能缺少 star / license / 提交时间等信息）`
  }

  let release = null
  if (repo) {
    try {
      release = await apiJson(`${API_ROOT}/repos/${slug}/releases/latest`, {
        settings,
        signal: exec.signal,
      })
    } catch {
      release = null
    }
  }

  const pkgText = await rawTextOrNull(slug, 'package.json', 'HEAD', { settings, signal: exec.signal })
  const pyText = await rawTextOrNull(slug, 'pyproject.toml', 'HEAD', { settings, signal: exec.signal })
  const cargoText = await rawTextOrNull(slug, 'Cargo.toml', 'HEAD', { settings, signal: exec.signal })
  const goText = await rawTextOrNull(slug, 'go.mod', 'HEAD', { settings, signal: exec.signal })

  const pkg = pkgText ? manifestCountsFromPackageJson(pkgText) : { ok: false }
  const ecosystem = pkg.ok
    ? 'Node / JavaScript'
    : pyText
      ? 'Python'
      : cargoText
        ? 'Rust'
        : goText
          ? 'Go'
          : '未知（未在仓库根目录找到 package.json / pyproject.toml / Cargo.toml / go.mod）'

  const license = repo?.license?.spdx_id ?? repo?.license?.name ?? (degraded ? '未知' : '无 license')
  out.push(`# ${slug}`)
  if (repo?.description) out.push(`> ${repo.description}`)

  const facts = []
  if (repo) {
    facts.push(`Stars：${fmtCount(repo.stargazers_count)}`)
    facts.push(`Forks：${fmtCount(repo.forks_count)}`)
    facts.push(`开放 issue/PR：${fmtCount(repo.open_issues_count)}`)
    facts.push(`主要语言：${repo.language ?? '未知'}`)
    facts.push(`最近推送：${fmtDate(repo.pushed_at)}（${daysSince(repo.pushed_at)} 天前）`)
    facts.push(`创建于：${fmtDate(repo.created_at)}`)
    facts.push(`体积：${fmtSizeMb(repo.size)}（KB 计 ${repo.size}）`)
    facts.push(`默认分支：${repo.default_branch ?? '未知'}`)
    facts.push(`归档：${repo.archived ? '是' : '否'}`)
    if (repo.homepage) facts.push(`主页：${repo.homepage}`)
    if (Array.isArray(repo.topics) && repo.topics.length > 0) facts.push(`标签：${repo.topics.slice(0, 8).join(', ')}`)
  }
  facts.push(`许可证：${license}`)
  facts.push(`生态：${ecosystem}`)
  facts.push(`地址：https://github.com/${slug}`)
  out.push(facts.map((line) => `- ${line}`).join('\n'))

  if (release) {
    out.push(
      `\n## 最新发布\n- ${release.tag_name ?? release.name ?? '未知 tag'}（${fmtDate(release.published_at)}）`,
    )
  }

  const depCount = pkg.ok ? pkg.dep.length : undefined
  const verdict = healthVerdict({
    pushedAt: repo?.pushed_at,
    archived: repo?.archived,
    license,
    sizeKb: repo?.size,
    depCount,
  })
  out.push(`\n## 体检结论\n${verdict.map((line) => `- ${line}`).join('\n')}`)

  if (pkg.ok) {
    out.push(
      [
        '\n## 依赖概况（package.json）',
        `- 包名：${pkg.name ?? '未知'} @ ${pkg.version ?? '未知'}`,
        `- dependencies ${pkg.dep.length} 个、devDependencies ${pkg.dev.length} 个、peerDependencies ${pkg.peer.length} 个`,
        `- 可直接装包：\`npm i ${pkg.name ?? slug.split('/')[1]}\`（或 \`pnpm add ${pkg.name ?? slug.split('/')[1]}\`）`,
        pkg.dep.length > 0 ? `- 运行时依赖样例：${pkg.dep.slice(0, 12).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  if (pyText) out.push('\n## Python 包线索\n- 根目录存在 pyproject.toml，可用 `pip install <包名>` 方式集成（详见 github_tree_and_manifest）。')

  if (wantsReadme) {
    const readme =
      (await rawTextOrNull(slug, 'README.md', 'HEAD', { settings, signal: exec.signal })) ??
      (await rawTextOrNull(slug, 'readme.md', 'HEAD', { settings, signal: exec.signal })) ??
      (await rawTextOrNull(slug, 'README.rst', 'HEAD', { settings, signal: exec.signal }))
    if (readme) out.push(`\n## README 摘要\n${clip(readme.trim(), 2500)}`)
    else out.push('\n## README 摘要\n（未找到 README）')
  }

  if (degraded) out.push(`\n${degraded}`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// github_tree_and_manifest
// ---------------------------------------------------------------------------

const MANIFEST_CANDIDATES = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'pubspec.yaml',
  'Gemfile',
  'pom.xml',
  'build.gradle.kts',
  'build.gradle',
  'Package.swift',
  'environment.yml',
]

function extractDeps(path, text, maxDeps) {
  const deps = []
  const lower = path.toLowerCase()
  if (lower.endsWith('package.json')) {
    const pkg = manifestCountsFromPackageJson(text)
    if (!pkg.ok) return { kind: 'package.json', error: '不是合法 JSON', deps: [], runtime: 0 }
    for (const [key, value] of Object.entries(JSON.parse(text).dependencies ?? {})) {
      deps.push(`${key}@${value}`)
    }
    return {
      kind: 'package.json',
      name: pkg.name,
      version: pkg.version,
      runtime: pkg.dep.length,
      dev: pkg.dev.length,
      peer: pkg.peer.length,
      deps: deps.slice(0, maxDeps),
      install: `npm i ${pkg.name ?? '<包名>'}`,
    }
  }
  if (lower.endsWith('requirements.txt')) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      deps.push(trimmed)
    }
    return { kind: 'requirements.txt', runtime: deps.length, deps: deps.slice(0, maxDeps), install: 'pip install -r requirements.txt' }
  }
  if (lower.endsWith('pyproject.toml')) {
    const matches = text.match(/^\s*["']?([A-Za-z0-9_.\-]+)["']?\s*(?:[<>=!~^]=?|\s*=|$)/gm) ?? []
    const section = text.includes('[tool.poetry.dependencies]')
      ? text.split('[tool.poetry.dependencies]')[1]?.split('\n[')[0] ?? ''
      : text.split('[project]')[1]?.split('\n[')[0] ?? text
    for (const line of section.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*=\s*["'\[{]/)
      if (m && m[1].toLowerCase() !== 'python') deps.push(m[1])
    }
    if (deps.length === 0) {
      const arr = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)
      if (arr) {
        for (const piece of arr[1].split(',')) {
          const m = piece.match(/["']([A-Za-z0-9_.\-]+)/)
          if (m) deps.push(m[1])
        }
      }
    }
    return { kind: 'pyproject.toml', runtime: deps.length, deps: deps.slice(0, maxDeps), install: 'pip install <包名>（或 poetry add / uv add）' }
  }
  if (lower.endsWith('cargo.toml')) {
    const section = text.split('[dependencies]')[1]?.split('\n[')[0] ?? ''
    for (const line of section.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_\-]+)\s*=/)
      if (m) deps.push(m[1])
    }
    return { kind: 'Cargo.toml', runtime: deps.length, deps: deps.slice(0, maxDeps), install: 'cargo add <crate>' }
  }
  if (lower.endsWith('go.mod')) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.\-/]+\.[\w]+\/[\w.\-/]+)\s+v/)
      if (m) deps.push(m[1])
    }
    return { kind: 'go.mod', runtime: deps.length, deps: deps.slice(0, maxDeps), install: 'go get <module>' }
  }
  if (lower.endsWith('composer.json')) {
    try {
      const pkg = JSON.parse(text)
      for (const [key] of Object.entries(pkg.require ?? {})) {
        if (key !== 'php') deps.push(key)
      }
      return { kind: 'composer.json', runtime: deps.length, deps: deps.slice(0, maxDeps), install: `composer require ${pkg.name ?? '<包名>'}` }
    } catch {
      return { kind: 'composer.json', error: '不是合法 JSON', deps: [], runtime: 0 }
    }
  }
  if (lower.endsWith('pubspec.yaml')) {
    const section = text.split(/^dependencies:/m)[1]?.split(/^\S/m)[0] ?? ''
    for (const line of section.split(/\r?\n/)) {
      const m = line.match(/^\s{2}([a-z0-9_]+):/)
      if (m && m[1] !== 'flutter') deps.push(m[1])
    }
    return { kind: 'pubspec.yaml', runtime: deps.length, deps: deps.slice(0, maxDeps), install: 'flutter pub add <包名>' }
  }
  if (lower.endsWith('gemfile')) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*gem\s+["']([^"']+)["']/)
      if (m) deps.push(m[1])
    }
    return { kind: 'Gemfile', runtime: deps.length, deps: deps.slice(0, maxDeps), install: 'bundle add <gem>' }
  }
  return { kind: path, runtime: 0, deps: [], install: '', note: '未识别的清单类型，请用 github_read 直接查看内容' }
}

function costLabel(runtime) {
  if (!Number.isFinite(runtime)) return '未知'
  if (runtime === 0) return '极低（无运行时依赖）'
  if (runtime <= 5) return '低'
  if (runtime <= 15) return '中'
  return '偏高（建议优先找更轻的替代）'
}

async function runManifest(args, exec, settings) {
  const { slug } = parseRepo(args.repo)
  const ref = String(args.ref ?? 'HEAD')
  const maxDeps = clampInt(args.maxDeps, 3, 80, 25)
  const paths = Array.isArray(args.paths) && args.paths.length > 0
    ? args.paths.map((p) => String(p)).slice(0, 10)
    : MANIFEST_CANDIDATES

  const found = []
  const batchSize = Number.isFinite(settings.concurrency) && settings.concurrency > 0 ? settings.concurrency : DEFAULT_CONCURRENCY
  for (let index = 0; index < paths.length; index += batchSize) {
    const batch = paths.slice(index, index + batchSize)
    const results = await Promise.all(
      batch.map(async (path) => ({
        path,
        text: await rawTextOrNull(slug, path, ref, { settings, signal: exec.signal }),
      })),
    )
    for (const { path, text } of results) {
      if (typeof text === 'string' && text.trim().length > 0) found.push({ path, text })
    }
  }

  const head = `# 依赖与集成成本：${slug} @ ${ref}`
  if (found.length === 0) {
    return [
      head,
      '',
      '未在根目录发现常见清单文件（package.json / pyproject.toml / requirements.txt / Cargo.toml / go.mod 等）。',
      '可能原因：仓库使用 monorepo 子目录、非常见语言，或该路径下确实没有清单。',
      '下一步：用 `github_read` 读 README 定位安装方式，或用 `github_tree_and_manifest` 的 `paths` 参数指定具体路径（如 `apps/web/package.json`）。',
    ].join('\n')
  }

  const blocks = found.map(({ path, text }) => {
    const info = extractDeps(path, text, maxDeps)
    const lines = [`## ${path}`]
    if (info.error) lines.push(`- 解析失败：${info.error}`)
    if (info.name) lines.push(`- 包名：${info.name}${info.version ? ` @ ${info.version}` : ''}`)
    lines.push(`- 运行时依赖：${info.runtime ?? 0} 个${info.dev !== undefined ? `（devDependencies ${info.dev} 个、peerDependencies ${info.peer ?? 0} 个）` : ''}`)
    lines.push(`- 集成成本：${costLabel(info.runtime ?? 0)}`)
    if (info.install) lines.push(`- 装包方式：\`${info.install}\`（不要 clone 整仓）`)
    if (info.deps?.length) lines.push(`- 依赖明细（前 ${info.deps.length} 项）：${info.deps.join(', ')}`)
    if (info.note) lines.push(`- ${info.note}`)
    return lines.join('\n')
  })

  const tail = [
    '',
    '判读建议：运行时依赖 ≤ 5 且许可证宽松 → 直接装包集成；依赖偏多或需要深度定制 → 先 `github_read` 确认导出接口，再决定装包还是取用部分源码（取用源码时务必保留原始 LICENSE 声明）。',
  ].join('\n')

  return `${head}\n\n${blocks.join('\n\n')}${tail}`
}

// ---------------------------------------------------------------------------
// github_read
// ---------------------------------------------------------------------------

async function runRead(args, exec, settings) {
  const { slug } = parseRepo(args.repo)
  const path = String(args.path ?? '').trim()
  if (!path) throw new Error('path 不能为空，例如 "README.md" 或 "src/index.ts"')
  const ref = String(args.ref ?? 'HEAD')
  const text = await rawText(slug, path, ref, { settings, signal: exec.signal })

  let body = text
  const startLine = Number.isFinite(args.startLine) && args.startLine > 0 ? Math.trunc(args.startLine) : 0
  if (startLine > 0) {
    const lines = text.split(/\r?\n/)
    const maxLines = clampInt(args.maxLines, 20, 2000, 400)
    body = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n')
  }

  const budget = clampInt(args.maxChars, 1000, settings.maxOutputChars, Math.min(12000, settings.maxOutputChars))
  const header = `# ${slug} :: ${path} @ ${ref}（共 ${text.length} 字符${text.split(/\r?\n/).length} 行）`
  const fence = body.includes('```') ? '~~~' : '```'
  return `${header}\n\n${fence}\n${clip(body, budget)}\n${fence}`
}

// ---------------------------------------------------------------------------
// 系统提示词与技能
// ---------------------------------------------------------------------------

const PROMPT_SECTION = `## 开源复用优先（github-reuse 插件已安装）

**硬性门槛：在编写任何自研实现之前，必须先给出至少 2 个开源候选（仓库名 + star + 许可证 + 最近更新时间），或者明确说明"已检索但无可用实现"及检索关键词。没有这一步就不要开始写代码。**

在从零实现一个功能之前，先判断它是否已被成熟开源项目解决；如果是，**优先复用，而不是重写**。

工作顺序：
0. 需求拆解 + 检索（门槛步骤，见上）。
1. \`github_search\`：把需求拆成 1–3 个领域关键词（必要时中英各一次），按 star / 最近推送排序检索。至少看两轮：通用领域词 + "具体技术词"。
2. \`github_inspect\`：对 2–4 个候选做体检，比较活跃度、许可证、体积、依赖规模。
3. \`github_tree_and_manifest\` + \`github_read\`：确认依赖清单与真实导出 API（不要凭记忆猜函数名），再动笔写集成代码。
4. 集成后必须实际运行验证，而不是只写完代码。

硬门槛（不满足就换候选或自研，并在回答里说明原因）：
- 许可证：MIT / Apache-2.0 / BSD / ISC 可直接用；GPL / AGPL 出现在需要闭源或商用的产品里必须先向用户确认；无许可证默认不可复用。
- 活跃度：近 12 个月有提交；若已归档或停更超过 18 个月，只能作为参考实现，不要作为依赖基座。
- 体积与依赖：**绝不 git clone 整仓**（本机磁盘紧张）。能用 \`npm i\` / \`pnpm add\` / \`pip install\` 装包就装包；只有无法装包时才用 \`github_read\` 取单个文件把必要源码抄进项目，并保留原始 LICENSE 与出处注释。
- 若仓库体积 > 50 MB 或 star 极少（< 100）且无人维护，视为高风险。

输出要求：给出"复用 / 自研"的结论 + 理由，列候选对比（star、许可证、最近更新、依赖数），写清集成步骤与风险（许可证、维护状态、版本锁定）。`

const SKILL_CONTENT = `# oss-reuse：用成熟开源项目拼装功能

## 硬性门槛（先做这一步）
动手写任何自研代码前，必须先给出**至少 2 个开源候选**（仓库名 + star + 许可证 + 最近更新），或明确写"已检索但无可用实现"并附上检索关键词。跳过这一步就等于违规。

## 何时用
用户提出一个功能需求，而这块能力很可能已有成熟实现（登录鉴权、图表、PDF 导出、解析器、调度器、状态机、编辑器、爬虫、CLI 框架、序列化、模糊测试等）。目标是**少写代码、拿现成能力**，而不是炫技手写。

## 四个工具
- \`github_search\`：检索仓库。参数：\`query\`（必填，GitHub 搜索语法）、\`minStars\`、\`language\`、\`license\`、\`pushedWithinDays\`、\`topic\`、\`sort\`（best-match / stars / updated）、\`maxResults\`。
- \`github_inspect\`：仓库体检，返回 star、fork、issue 数、语言、最近推送、体积、归档状态、许可证、最新 release、依赖概况、README 摘要、体检结论。
- \`github_tree_and_manifest\`：在线读取根目录清单（package.json / pyproject.toml / requirements.txt / Cargo.toml / go.mod / composer.json / pubspec.yaml / Gemfile），给出依赖数与装包命令，估算集成成本。可用 \`paths\` 指定 monorepo 子目录。
- \`github_read\`：读仓库内任意文件（走 raw 通道，不受 API 配额限制），用于确认导出 API、示例代码、许可证文本。

## 标准流程
1. **需求拆解**：把需求拆成"能力块"，例如「导出 Excel」= 表格写入 + 样式 + 公式。每块单独找库。
2. **分区检索**：每块用 2–3 个不同说法搜索（\`xlsx writer\`、\`spreadsheet export\`、\`excel stylesheet\`），中文需求再补一次中文关键词。
3. **体检对比**：对每个候选跑 \`github_inspect\`，把结果整理成表。
4. **确认 API**：跑 \`github_read\` 读 README 的 Usage 段与 \`types\`/\`index.d.ts\`，确认函数签名确实存在。
5. **试集成**：按装包命令安装最小依赖集，写一个最小可运行示例先跑通，再扩到完整需求。
6. **记录决策**：在回答里写出选型理由、被否掉的候选与否掉原因、许可证与维护风险。

## 常见坑
- 不要凭记忆写库的 API：先 \`github_read\` 看真实签名。
- 不要 clone：磁盘紧张，且 clone 下来的代码你还得自己维护。
- 注意 ESM/CJS 与 Node 版本要求，看 \`package.json\` 的 \`engines\`/\`type\`。
- monorepo 仓库的根 package.json 往往只是壳，真正的包在 \`packages/*\` 下，用 \`paths\` 参数指过去。
- 许可证为 GPL/AGPL 时，闭源分发有传染风险，必须先问用户。
- 依赖数量爆炸的库（> 30 个运行时依赖）在受限环境里容易装不上，优先选零依赖实现。`

function registerPrompt(ctx, logger) {
  const systemPrompt = ctx.systemPrompt
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    logger?.warn?.('github-reuse: 未找到 systemPrompt 服务，跳过提示词注入')
    return
  }
  systemPrompt.section({
    name: 'github-reuse:policy',
    order: 760,
    text: PROMPT_SECTION,
  })
}

function registerSkill(ctx, logger) {
  const skills = ctx.skills
  if (!skills || typeof skills.register !== 'function') {
    logger?.warn?.('github-reuse: 未找到 skills 服务，跳过 oss-reuse 技能注册')
    return
  }
  skills.register({
    name: 'oss-reuse',
    description:
      '在用成熟开源项目拼装功能时使用：检索 GitHub、体检候选、确认依赖与真实 API，然后优先装包集成而不是从零实现。',
    whenToUse:
      '用户需求里包含已被广泛解决的通用能力（鉴权、图表、导出、解析、编辑器、调度、CLI、序列化等），或明确希望"用现成开源项目而不是自己写"时。',
    source: 'dsh-github-reuse',
    content: SKILL_CONTENT,
  })
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const settings = readSettings(config)
  const logger = ctx.logger

  const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

  ctx.tools.register(
    defineTool({
      name: 'github_search',
      description:
        '在 GitHub 上检索开源仓库，用于判断某个功能是否已有成熟实现。支持 star 下限、语言、许可证、最近推送时间、topic 过滤与排序。只走在线 API，不 clone 仓库。',
      parameters: {
        query: { type: 'string', required: true, description: 'GitHub 搜索关键词，可用搜索语法，如 "xlsx export" 或 "state machine typescript"。' },
        maxResults: { type: 'integer', description: '返回条数，默认 8，最大 20。' },
        minStars: { type: 'integer', description: 'star 数下限，如 500。' },
        language: { type: 'string', description: '限定主要语言，如 python / typescript / go。' },
        license: { type: 'string', description: '限定许可证，如 mit / apache-2.0 / bsd-3-clause。' },
        pushedWithinDays: { type: 'integer', description: '只保留最近 N 天有推送的仓库，如 365。' },
        topic: { type: 'string', description: '限定 GitHub topic。' },
        sort: { type: 'string', enum: ['best-match', 'stars', 'updated'], description: '排序方式，默认 best-match。' },
        includeArchived: { type: 'boolean', description: '是否包含已归档仓库，默认 false。' },
        includeForks: { type: 'boolean', description: '是否包含 fork，默认 false。' },
      },
      output: textOutput,
      timeoutMs: 30000,
      isConcurrencySafe: () => true,
      execute: (args, exec) => runSearch(args, exec, settings),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_inspect',
      description:
        '对一个 GitHub 仓库做体检：star/fork/issue 数、主要语言、最近推送、体积、是否归档、许可证、最新 release、依赖概况与 README 摘要，并给出是否值得复用的结论。API 配额耗尽时会自动降级为 raw 文件通道。',
      parameters: {
        repo: { type: 'string', required: true, description: '仓库标识，如 "owner/name" 或完整 GitHub 链接。' },
        includeReadme: { type: 'boolean', description: '是否附带 README 摘要，默认 true。' },
      },
      output: textOutput,
      timeoutMs: 40000,
      isConcurrencySafe: () => true,
      execute: (args, exec) => runInspect(args, exec, settings),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_tree_and_manifest',
      description:
        '在线读取仓库根目录的依赖清单（package.json / pyproject.toml / requirements.txt / Cargo.toml / go.mod / composer.json / pubspec.yaml / Gemfile 等），输出依赖数量、明细与装包命令，用于估算集成成本。不 clone 仓库。',
      parameters: {
        repo: { type: 'string', required: true, description: '仓库标识，如 "owner/name"。' },
        paths: { type: 'array', items: { type: 'string' }, description: '自定义要读取的清单路径列表（用于 monorepo 子目录），如 ["packages/core/package.json"]。' },
        ref: { type: 'string', description: '分支 / tag / commit，默认 HEAD。' },
        maxDeps: { type: 'integer', description: '每个清单最多列出的依赖条数，默认 25。' },
      },
      output: textOutput,
      timeoutMs: 60000,
      isConcurrencySafe: () => true,
      execute: (args, exec) => runManifest(args, exec, settings),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_read',
      description:
        '在线读取 GitHub 仓库里的任意文本文件（raw 通道，不消耗 API 配额）：用于确认真实导出 API、示例代码、类型定义或许可证原文。支持按起始行与最大行数分段读取。',
      parameters: {
        repo: { type: 'string', required: true, description: '仓库标识，如 "owner/name"。' },
        path: { type: 'string', required: true, description: '仓库内文件路径，如 "README.md"、"src/index.ts"、"packages/core/package.json"。' },
        ref: { type: 'string', description: '分支 / tag / commit，默认 HEAD。' },
        startLine: { type: 'integer', description: '起始行（1 起），用于分段读取长文件。' },
        maxLines: { type: 'integer', description: '配合 startLine 使用，最多读取行数，默认 400。' },
        maxChars: { type: 'integer', description: '输出字符上限，默认 12000。' },
      },
      output: textOutput,
      timeoutMs: 30000,
      isConcurrencySafe: () => true,
      execute: (args, exec) => runRead(args, exec, settings),
    }),
  )

  // 提示词与技能是可选依赖：服务可用时才挂上，避免插件因缺服务而整体不加载。
  const onReady = (deps, task) => {
    try {
      if (typeof ctx.inject === 'function') ctx.inject(deps, (sub) => task(sub))
      else task(ctx)
    } catch (error) {
      logger?.warn?.(`github-reuse: 挂载 ${deps.join('/')} 失败：${error?.message ?? error}`)
    }
  }

  onReady(['systemPrompt'], (sub) => {
    try {
      registerPrompt(sub, logger)
    } catch (error) {
      logger?.warn?.(`github-reuse: 注入系统提示词失败：${error?.message ?? error}`)
    }
  })
  onReady(['skills'], (sub) => {
    try {
      registerSkill(sub, logger)
    } catch (error) {
      logger?.warn?.(`github-reuse: 注册 oss-reuse 技能失败：${error?.message ?? error}`)
    }
  })
}
