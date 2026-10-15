/**
 * dsh-vsc-companion — host-side bundle for dsh-vsc.
 *
 * Registered through this plugin's own context only (no shared-registry
 * patching), and with no `@deepseek-ai/*` value imports: message identities,
 * tool definitions, and projection schemas are all built from plain objects
 * plus `zod`, the same convention third-party bundles use.
 *
 * Two surfaces:
 *  - task-checklist stewardship: a shadow projection over `todo/write` plus a
 *    dynamic runtime-context section that tells the model the live checklist
 *    and the step-by-step update rule.
 *  - host-side page tools: `page_screenshot` / `page_eval` run a headless
 *    Edge/Chromium in this host process, outside the command sandbox, write
 *    the PNG into the session workspace, and attach the image to the
 *    conversation through `exec.deferContext`.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

export const name = 'dsh-vsc-companion'

export const inject = ['tools', 'sessionProjections', 'attachments']

const TODO_STATUSES = ['pending', 'in_progress', 'completed']
const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(TODO_STATUSES),
})
const todoListSchema = z.array(todoItemSchema).nullable()

/** Contexts join in ascending order; sit right after the approval policy (115). */
const CONTEXT_ORDER_TODOS = 117
const MAX_TODO_LINES = 40

const DEFAULT_WAIT_MS = 1500
const MAX_WAIT_MS = 15000
const NAV_TIMEOUT_MS = 30000
const MAX_VIEWPORT = 4096
const MAX_EVAL_RESULT_CHARS = 20000

export function apply(ctx) {
  ctx.sessionProjections.register({
    key: 'companionTodos',
    stateSchema: todoListSchema,
    stateVersion: 1,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'todo/write') {
        return Array.isArray(event.data?.todos) ? event.data.todos : state
      }
      return state
    },
    wire: {
      viewSchema: todoListSchema,
      view: (state) => state,
    },
  })

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'companion:todos',
      order: CONTEXT_ORDER_TODOS,
      text: (context) => {
        const session = context.agent?.session
        if (session === undefined) return ''
        try {
          const live = ctx.sessionProjections.stateOf(session, 'todos')
          const shadow = ctx.sessionProjections.stateOf(session, 'companionTodos')
          return renderTodoSection(live, shadow)
        } catch {
          return ''
        }
      },
    })
  })

  ctx.tools.register(pageScreenshotTool(ctx))
  ctx.tools.register(pageEvalTool(ctx))
}

/** The model-facing checklist section; '' contributes nothing. */
function renderTodoSection(live, shadow) {
  const current = Array.isArray(live) && live.length > 0 ? live : null
  if (current !== null) {
    const lines = ['Current task checklist (live):']
    for (const item of current.slice(0, MAX_TODO_LINES)) {
      lines.push(`- [${item.status}] ${item.content}`)
    }
    const allDone = current.every((item) => item.status === 'completed')
    lines.push(allDone
      ? 'Every step is marked completed. If the task itself has finished, no further checklist update is needed.'
      : 'Keep it current: the moment one step finishes, immediately call todo_write with that step completed and the next one in_progress. Never batch checklist updates at the end of the task.')
    return lines.join('\n')
  }
  const stale = Array.isArray(shadow) && shadow.some((item) => item.status !== 'completed') ? shadow : null
  if (stale !== null) {
    const lines = ['The session checklist was cleared when this turn started. Last known list (stale):']
    for (const item of stale.slice(0, MAX_TODO_LINES)) {
      lines.push(`- [${item.status}] ${item.content}`)
    }
    lines.push('If you are continuing this work, first call todo_write with the up-to-date list (finished steps marked completed), then proceed, keeping it updated as each step completes.')
    return lines.join('\n')
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* page tools                                                          */
/* ------------------------------------------------------------------ */

const SOURCE_PARAMETER = {
  type: 'string',
  description: 'Workspace-relative or absolute path to an HTML file, or a loopback http(s) URL such as http://localhost:3000.',
}

function pageScreenshotTool(ctx) {
  return {
    name: 'page_screenshot',
    description: 'Render a page in a headless Edge/Chromium browser running in the host process, OUTSIDE the command sandbox (the sandbox forbids the named pipes browsers need), and capture a PNG. The image is attached to the conversation right after the tool result, and the PNG is also written into the workspace. Use it for visual checks of local HTML or local preview servers; pair with page_eval for programmatic assertions.',
    parameters: {
      type: 'object',
      properties: {
        source: SOURCE_PARAMETER,
        out: {
          type: 'string',
          description: 'Workspace-relative PNG output path; defaults to .dsh-vsc/shots/<name>-<timestamp>.png. A missing .png suffix is added automatically.',
        },
        viewport: {
          type: 'object',
          properties: {
            width: { type: 'integer', description: 'CSS pixels (default 1280, max 4096).' },
            height: { type: 'integer', description: 'CSS pixels (default 720, max 4096).' },
          },
          required: ['width', 'height'],
          additionalProperties: false,
          description: 'CSS-pixel viewport; the default keeps the content-native 1x scale.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of the viewport (playwright path only).',
        },
        waitMs: {
          type: 'integer',
          description: `Extra settle time after the load event (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}).`,
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          title: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          engine: { type: 'string' },
          attached: { type: 'boolean' },
          consoleErrors: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'title', 'width', 'height', 'bytes', 'engine', 'attached', 'consoleErrors'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderScreenshotText(value) }],
    },
    execute: (args, exec) => executeScreenshot(ctx, args, exec),
    presentCall: (args) => ({
      card: 'generic',
      title: `Screenshot ${typeof args?.source === 'string' ? args.source : ''}`.trim(),
      kind: 'other',
      rawInput: args,
    }),
  }
}

function renderScreenshotText(value) {
  const parts = [`Screenshot saved to ${value.path} (${value.width}x${value.height} css px, ${value.engine}).`]
  if (value.title !== '') parts.push(`Page title: ${value.title}`)
  parts.push(value.attached
    ? 'The image was attached to the conversation as the message right after this tool result; inspect it visually.'
    : 'The image could not be attached to the conversation; verify details with page_eval or open the PNG from the workspace path.')
  if (value.consoleErrors.length > 0) {
    parts.push(`Console errors (${value.consoleErrors.length}):`, ...value.consoleErrors.map((line) => `- ${line}`))
  }
  return parts.join('\n')
}

async function executeScreenshot(ctx, args, exec) {
  const cwd = sessionCwd(exec)
  if (cwd === undefined) throw new Error('page_screenshot needs a session workspace (the session has no cwd)')
  const source = resolveSource(String(args.source), cwd)
  const width = clampInt(args?.viewport?.width, 320, MAX_VIEWPORT, 1280)
  const height = clampInt(args?.viewport?.height, 200, MAX_VIEWPORT, 720)
  const fullPage = args?.fullPage === true
  const waitMs = clampInt(args?.waitMs, 0, MAX_WAIT_MS, DEFAULT_WAIT_MS)
  const outAbs = resolveOut(args?.out, source, cwd)

  const shot = await capturePage({ url: source.url, width, height, fullPage, waitMs })
  await mkdir(path.dirname(outAbs), { recursive: true })
  await writeFile(outAbs, shot.png)

  let attached = false
  try {
    const ref = await ctx.attachments.saveImage({
      data: new Uint8Array(shot.png),
      mediaType: 'image/png',
      name: path.basename(outAbs),
    })
    if (typeof exec?.deferContext === 'function') {
      exec.deferContext({
        id: randomUUID(),
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Screenshot of ${source.label} (${shot.width}x${shot.height} css px, ${shot.engine}). File: ${path.relative(cwd, outAbs)}`,
          },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'companion' },
      })
      attached = true
    }
  } catch {
    attached = false
  }

  return {
    path: path.relative(cwd, outAbs),
    title: shot.title,
    width: shot.width,
    height: shot.height,
    bytes: shot.png.length,
    engine: shot.engine,
    attached,
    consoleErrors: shot.consoleErrors,
  }
}

function pageEvalTool(ctx) {
  return {
    name: 'page_eval',
    description: 'Load a page in a headless Edge/Chromium browser running in the host process, OUTSIDE the command sandbox, and evaluate one JavaScript expression (or function source) inside it. Returns the JSON-serialized result plus console output — the right tool for renderer/WebGL/shader assertions, DOM queries, and frame diagnostics that a screenshot cannot prove.',
    parameters: {
      type: 'object',
      properties: {
        source: SOURCE_PARAMETER,
        script: {
          type: 'string',
          description: 'JavaScript expression or function source evaluated inside the page; the return value must be JSON-serializable (e.g. "(() => { const c = document.querySelector(\'canvas\'); return { webgl2: !!c?.getContext(\'webgl2\') }; })()").',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Evaluation timeout (default 15000, max 60000).',
        },
      },
      required: ['source', 'script'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          result: {},
          error: { type: 'string' },
          title: { type: 'string' },
          console: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'result', 'title', 'console'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderEvalText(value) }],
    },
    execute: (args, exec) => executeEval(ctx, args, exec),
    presentCall: (args) => ({
      card: 'generic',
      title: `Eval in ${typeof args?.source === 'string' ? args.source : ''}`.trim(),
      kind: 'other',
      rawInput: args,
    }),
  }
}

function renderEvalText(value) {
  const lines = []
  lines.push(value.ok ? 'Evaluation succeeded.' : `Evaluation failed: ${value.error ?? 'unknown error'}`)
  if (value.title !== '') lines.push(`Page title: ${value.title}`)
  lines.push('Result:', typeof value.result === 'string' ? value.result : JSON.stringify(value.result, null, 2))
  if (value.console.length > 0) lines.push('Console:', ...value.console.map((line) => `- ${line}`))
  return lines.join('\n')
}

async function executeEval(ctx, args, exec) {
  const cwd = sessionCwd(exec)
  if (cwd === undefined) throw new Error('page_eval needs a session workspace (the session has no cwd)')
  const source = resolveSource(String(args.source), cwd)
  const script = String(args.script)
  const timeoutMs = clampInt(args?.timeoutMs, 100, 60000, 15000)

  const playwright = await importPlaywright()
  if (playwright === null) {
    throw new Error('page_eval requires playwright-core; it was not resolvable in this harness. Install the companion bundle with its dependencies (the dsh-vsc extension does this automatically).')
  }

  return withBrowser(playwright, async (browser) => {
    const page = await browser.newPage()
    const consoleLines = []
    const collect = (line) => {
      if (consoleLines.length < 50) consoleLines.push(line)
    }
    page.on('console', (msg) => collect(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (error) => collect(`[pageerror] ${error?.message ?? String(error)}`))
    await page.goto(source.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
    let result
    let error
    try {
      result = await page.evaluate(script, { timeout: timeoutMs })
    } catch (thrown) {
      error = thrown?.message ?? String(thrown)
    }
    let title = ''
    try {
      title = await page.title()
    } catch {
      title = ''
    }
    return {
      ok: error === undefined,
      result: serializeResult(error === undefined ? result : null),
      ...(error !== undefined ? { error } : {}),
      title,
      console: consoleLines,
    }
  })
}

function serializeResult(value) {
  try {
    const json = JSON.stringify(value ?? null)
    if (json === undefined) return null
    return json.length > MAX_EVAL_RESULT_CHARS ? `${json.slice(0, MAX_EVAL_RESULT_CHARS)}… (truncated)` : JSON.parse(json)
  } catch {
    const text = String(value)
    return text.length > MAX_EVAL_RESULT_CHARS ? `${text.slice(0, MAX_EVAL_RESULT_CHARS)}… (truncated)` : text
  }
}

/* ------------------------------------------------------------------ */
/* browser plumbing                                                    */
/* ------------------------------------------------------------------ */

async function importPlaywright() {
  try {
    const module = await import('playwright-core')
    return module?.chromium !== undefined ? module : null
  } catch {
    return null
  }
}

function edgeExecutablePaths() {
  const candidates = [
    process.env['DSH_VSC_EDGE_PATH'],
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
  ]
  return candidates.filter((candidate) => typeof candidate === 'string' && candidate !== '')
}

async function capturePage({ url, width, height, fullPage, waitMs }) {
  const playwright = await importPlaywright()
  let playwrightError
  if (playwright !== null) {
    const attempts = [
      { label: 'msedge', options: { channel: 'msedge' } },
      { label: 'chrome', options: { channel: 'chrome' } },
      ...edgeExecutablePaths().map((executable) => ({ label: `edge:${executable}`, options: { executablePath: executable } })),
    ]
    for (const attempt of attempts) {
      let browser
      try {
        browser = await playwright.chromium.launch({ headless: true, ...attempt.options })
      } catch (error) {
        playwrightError = error
        continue
      }
      try {
        const page = await browser.newPage({
          viewport: { width, height },
          deviceScaleFactor: 1,
        })
        const consoleErrors = []
        page.on('console', (msg) => {
          if (msg.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(msg.text())
        })
        page.on('pageerror', (error) => {
          if (consoleErrors.length < 20) consoleErrors.push(String(error?.message ?? error))
        })
        await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
        if (waitMs > 0) await page.waitForTimeout(waitMs)
        const png = await page.screenshot({ fullPage, type: 'png' })
        const title = await page.title()
        const scrollHeight = await page
          .evaluate(() => document.documentElement?.scrollHeight ?? 0)
          .catch(() => 0)
        return {
          png: Buffer.from(png),
          title,
          consoleErrors,
          width,
          height: fullPage && scrollHeight > 0 ? scrollHeight : height,
          engine: `playwright:${attempt.label}`,
        }
      } finally {
        await browser.close().catch(() => {})
      }
    }
  }
  const cli = await captureWithEdgeCli({ url, width, height, waitMs })
  if (cli !== null) return cli
  throw playwrightError ?? new Error('no chromium-based browser is available for page_screenshot (tried playwright-core channels msedge/chrome/executables and the Edge CLI fallback)')
}

async function captureWithEdgeCli({ url, width, height, waitMs }) {
  const executable = edgeExecutablePaths().find((candidate) => existsSync(candidate))
  if (executable === undefined) return null
  const outPath = path.join(os.tmpdir(), `dsh-vsc-shot-${Date.now()}-${process.pid}.png`)
  const budget = Math.max(waitMs, 1000)
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${budget}`,
    `--screenshot=${outPath}`,
    url,
  ]
  try {
    await runProcess(executable, args, 60000)
    const png = await readFile(outPath)
    return {
      png,
      title: '',
      consoleErrors: [],
      width,
      height,
      engine: 'edge-cli',
    }
  } finally {
    await rm(outPath, { force: true }).catch(() => {})
  }
}

function runProcess(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${path.basename(executable)} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(executable)} exited with code ${code}`))
    })
  })
}

async function withBrowser(playwright, body) {
  const attempts = [
    { label: 'msedge', options: { channel: 'msedge' } },
    { label: 'chrome', options: { channel: 'chrome' } },
    ...edgeExecutablePaths().map((executable) => ({ label: `edge:${executable}`, options: { executablePath: executable } })),
  ]
  let lastError
  for (const attempt of attempts) {
    let browser
    try {
      browser = await playwright.chromium.launch({ headless: true, ...attempt.options })
    } catch (error) {
      lastError = error
      continue
    }
    try {
      return await body(browser)
    } finally {
      await browser.close().catch(() => {})
    }
  }
  throw lastError ?? new Error('no chromium-based browser is available')
}

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function assertInside(cwd, absolute) {
  const relative = path.relative(cwd, absolute)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return
  throw new Error(`path escapes the session workspace: ${absolute}`)
}

function resolveSource(raw, cwd) {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('source must not be empty')
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase()
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
      throw new Error(`page tools only accept loopback http(s) URLs; got host ${host}`)
    }
    return { url: url.href, label: url.href }
  }
  const absolute = path.resolve(cwd, trimmed)
  assertInside(cwd, absolute)
  return { url: pathToFileURL(absolute).href, label: path.relative(cwd, absolute) || trimmed }
}

function resolveOut(raw, source, cwd) {
  if (typeof raw === 'string' && raw.trim() !== '') {
    let absolute = path.resolve(cwd, raw.trim())
    if (!/\.png$/i.test(absolute)) absolute += '.png'
    assertInside(cwd, absolute)
    return absolute
  }
  const stem = sanitizeStem(source.label)
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  return path.join(cwd, '.dsh-vsc', 'shots', `${stem}-${stamp}.png`)
}

function sanitizeStem(label) {
  const base = label.replace(/^https?:\/\//i, '').replace(/[/\\:?#=&%]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[.-]+|[.-]+$/g, '')
  const stem = base === '' ? 'page' : base
  return stem.length > 60 ? stem.slice(0, 60) : stem
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}
