/**
 * dsh-win-bash — a GNU bash tool for DeepSeek Harness on Windows.
 *
 * DSH's host bash executor is POSIX-only (`@deepseek-ai/dsh-bash-local` hardcodes
 * the binary) and the Windows presets disable `tool-bash`, so a Windows agent
 * otherwise only has `pwsh`. This bundle registers a second, independent tool
 * that runs Git Bash (MSYS2) through `ctx.subprocess`, over the same Windows
 * filesystem the other tools see.
 *
 * Scope: `danger-full-access` only. A restricted Windows token cannot give an
 * MSYS child its signal pipe (`couldn't create signal pipe, Win32 error 5`), and
 * this bundle carries no Niubash payload or IPC shim to work around that. Every
 * call re-checks the session's sandbox policy and refuses instead of running
 * unconfined.
 *
 * A call that never produces a command result reports it as data — `status` plus
 * a `failure` carrying `code`/`effectState`/`retry` — instead of throwing, because
 * a thrown error loses the reason and does not satisfy `output.schema`.
 *
 * @module dsh-win-bash
 */

import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-win-bash'
export const inject = ['tools', 'subprocess', 'systemPrompt']

const TOOL_NAME = 'bash'
const FALLBACK_TOOL_NAME = 'win_bash'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const GRACE_MS = 3_000
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_SPILL_BYTES = 64 * 1024 * 1024
/** Windows CreateProcess rejects longer command lines; stay well inside the limit. */
const MAX_COMMAND_LENGTH = 30_000
const FULL_ACCESS = 'danger-full-access'

/** Environment overrides that keep MSYS output readable and pipe-friendly. */
const SHELL_ENV = Object.freeze({
  TERM: 'dumb',
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  LC_MESSAGES: 'C',
})

const DESCRIPTION = [
  'Run a command in GNU bash (Git Bash / MSYS2) on Windows and return its stdout/stderr.',
  'This is not PowerShell: use bash quoting, $VAR, $(command), pipes and redirects.',
  'Each call is a fresh shell; pass workdir instead of cd. Relative workdir resolves against the session workspace; workdir accepts D:/repo or /d/repo. Inside the command use MSYS paths such as /d/repo, and quote paths that contain spaces.',
  'For a script longer than a screen, or one containing heredocs, backslashes, nested quotes or non-ASCII text, write the file first and pass script_path instead of inlining it in command.',
  'Foreground only: there is no run_in_background and no job id, so a server or watcher holds the call until timeoutMs.',
  'Use bash for POSIX work: pipelines, grep/sed/awk/find, shell scripts, git, make. Use pwsh for Windows-native objects: registry, services, scheduled tasks, WMI/CIM, .NET APIs.',
  'Long output is truncated to its tail; the full stream is saved to a spill file whose path is reported when available. stdout and stderr text may be partial: check the truncation note before parsing them as complete, and treat the spill path as convenience, not as proof the stream was captured.',
  'Exit status is reported as [exit code: N]; a non-zero code is a command result, not a tool failure. Verify resolved absolute targets before delete or move.',
  'Runs only in danger-full-access sessions; other sessions get a refusal instead of an unconfined command.',
  'A [CODE; effects: ...; retry: ...] line means no command result exists; read effects before retrying. Unknown parameters are rejected and named, never silently ignored.',
].join(' ')

const STREAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'truncated'],
  properties: {
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    spillPath: { type: 'string' },
  },
}

/** Why a call produced no command result, and what the model may do next. */
const FAILURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'effectState', 'retry'],
  properties: {
    code: {
      type: 'string',
      enum: ['INVALID_ARGUMENT', 'CANCELLED', 'EXECUTOR_UNAVAILABLE', 'SPAWN_FAILED', 'SUBPROCESS_ERROR', 'INTERNAL_ERROR'],
    },
    message: { type: 'string' },
    effectState: { type: 'string', enum: ['none', 'unknown'] },
    retry: { type: 'string', enum: ['never', 'after-input-change'] },
    nextAction: { type: 'string' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'exitCode', 'signal', 'timedOut', 'timeoutMs', 'stdout', 'stderr'],
  properties: {
    status: { type: 'string', enum: ['completed', 'failed'] },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    timeoutMs: { type: 'number' },
    stdout: STREAM_SCHEMA,
    stderr: STREAM_SCHEMA,
    failure: FAILURE_SCHEMA,
  },
}

/**
 * Arguments this tool reads. A plain tool definition gets only `output.schema`
 * validated and receives the model's arguments untouched, so an undeclared key is
 * dropped silently; a swallowed `run_in_background` would run the command in the
 * foreground for its whole timeout.
 */
const KNOWN_ARGUMENTS = ['description', 'command', 'script_path', 'workdir', 'timeoutMs']

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: {
      type: 'string',
      description: 'Clear active-voice description of this command, 5–10 words.',
    },
    command: {
      type: 'string',
      description: 'Bash command or pipeline. Provide exactly one of command and script_path.',
    },
    script_path: {
      type: 'string',
      description: 'Windows path to an existing bash script. Provide exactly one of command and script_path.',
    },
    workdir: {
      type: 'string',
      description: 'Working directory. Defaults to the session workspace. Accepts D:/repo or /d/repo; a relative path resolves against the session workspace. Drive-less POSIX paths such as /tmp are rejected.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Kill the command after this many milliseconds. Defaults to 120000; capped at 600000.',
    },
  },
}

/** Argument errors that are reported to the model as a clean refusal, not a crash. */
class CallArgumentError extends Error {}

/** The session cannot run bash at all, so retrying the same call is pointless. */
class UnavailableError extends Error {}

/**
 * Register the bash tool for this profile.
 * @param ctx - the plugin context.
 * @param config - the row config: `{ bashPath, timeoutMs, extraGuidance }`.
 */
export function apply(ctx, config) {
  if (process.platform !== 'win32') {
    ctx.logger?.info?.(`dsh-win-bash: Windows-only plugin, inactive on ${process.platform}.`)
    return
  }

  const settings = normalizeSettings(config, ctx)
  const resolved = resolveBash(settings)
  if (resolved.error !== undefined) {
    ctx.logger?.warn?.(`dsh-win-bash: ${resolved.error}`)
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'dsh-win-bash:unavailable',
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
      interpolate: false,
      text: unavailable(resolved.error),
    }))
    return
  }

  let toolName
  for (const candidate of [TOOL_NAME, FALLBACK_TOOL_NAME]) {
    try {
      const dispose = ctx.tools.register(createDefinition(ctx, resolved.file, settings, candidate))
      ctx.effect(() => dispose)
      toolName = candidate
      break
    } catch (error) {
      ctx.logger?.warn?.(`dsh-win-bash: cannot register "${candidate}": ${errorMessage(error)}`)
    }
  }
  if (toolName === undefined) return

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-win-bash:guidance',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    interpolate: false,
    text: guidance(toolName, settings),
  }))
  ctx.logger?.info?.(`dsh-win-bash: registered "${toolName}" -> ${resolved.file} (${resolved.source}).`)
}

/**
 * Normalize and validate the row config. Invalid values are reported and replaced
 * by defaults rather than preventing the tool from loading.
 * @param config - raw row config.
 * @param ctx - plugin context, used for warnings.
 * @returns frozen settings.
 */
function normalizeSettings(config, ctx) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const timeoutMs = clampTimeout(raw.timeoutMs, ctx)

  let bashPath
  if (raw.bashPath !== undefined && raw.bashPath !== null && raw.bashPath !== '') {
    if (typeof raw.bashPath !== 'string') ctx.logger?.warn?.('dsh-win-bash: bashPath must be a string; ignoring it.')
    else bashPath = raw.bashPath.trim()
  }

  let extraGuidance = ''
  if (typeof raw.extraGuidance === 'string') extraGuidance = raw.extraGuidance.trim()

  return Object.freeze({ bashPath, timeoutMs, extraGuidance })
}

/**
 * Clamp one timeout to the supported range.
 * @param value - requested milliseconds.
 * @param ctx - plugin context, used for warnings.
 * @returns a positive integer within the supported range.
 */
function clampTimeout(value, ctx) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(value) || value <= 0) {
    ctx?.logger?.warn?.(`dsh-win-bash: ignored invalid timeoutMs ${JSON.stringify(value)}.`)
    return DEFAULT_TIMEOUT_MS
  }
  const clamped = Math.min(Math.floor(value), MAX_TIMEOUT_MS)
  if (clamped !== Math.floor(value)) {
    ctx?.logger?.warn?.(`dsh-win-bash: timeoutMs capped at ${MAX_TIMEOUT_MS}.`)
  }
  return clamped
}

/**
 * Resolve the bash executable. An explicit `bashPath` is authoritative: when it
 * is unusable the tool does not fall back to a different installation.
 * @param settings - normalized settings.
 * @param env - environment to read install locations from.
 * @param platform - target platform.
 * @returns `{ file, source }` or `{ error }`.
 */
export function resolveBash(settings = {}, env = process.env, platform = process.platform) {
  if (typeof settings.bashPath === 'string' && settings.bashPath !== '') {
    const file = path.win32.normalize(settings.bashPath)
    if (!isFile(file)) return { error: `bashPath is not an existing file: ${file}` }
    if (isWslBashLauncher(file, env, platform)) {
      return { error: `bashPath points at the WSL launcher, not Git Bash: ${file}` }
    }
    return { file, source: 'config' }
  }

  if (platform !== 'win32') return { error: `no bash resolver for platform ${platform}` }

  for (const file of wellKnownCandidates(env)) {
    if (isFile(file) && !isWslBashLauncher(file, env, platform)) return { file, source: 'well-known' }
  }
  for (const file of pathCandidates(env)) {
    if (isFile(file) && !isWslBashLauncher(file, env, platform)) return { file, source: 'PATH' }
  }
  return {
    error: 'no Git Bash found. Install Git for Windows, or set bashPath to its bin\\bash.exe.',
  }
}

/**
 * Probe Git for Windows and common MSYS distributions, best first.
 * @param env - environment to read.
 * @returns candidate executable paths.
 */
export function wellKnownCandidates(env = process.env) {
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA ?? env.LocalAppData ?? ''
  const userProfile = env.USERPROFILE ?? ''

  const candidates = [
    path.win32.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.win32.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    path.win32.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    localAppData === '' ? '' : path.win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
    userProfile === '' ? '' : path.win32.join(userProfile, 'scoop', 'shims', 'bash.exe'),
    userProfile === '' ? '' : path.win32.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\bash.exe',
    'C:\\tools\\msys64\\usr\\bin\\bash.exe',
    'C:\\msys64\\usr\\bin\\bash.exe',
  ]
  return dedupe(candidates.filter(candidate => candidate !== ''))
}

/**
 * Read `PATH` for a Git for Windows bin directory.
 * @param env - environment to read.
 * @returns candidate executable paths.
 */
export function pathCandidates(env = process.env) {
  const value = env.Path ?? env.PATH ?? ''
  return dedupe(value.split(path.win32.delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    .map(entry => path.win32.join(entry, 'bash.exe')))
}

/**
 * Reject the WSL launcher. `System32\bash.exe` and its Store alias look like a
 * usable bash but execute the command inside a Linux distribution, over a
 * different filesystem, without saying so.
 * @param file - candidate executable.
 * @param env - environment containing SystemRoot and LOCALAPPDATA.
 * @param platform - target platform.
 * @returns whether the candidate is a WSL launcher.
 */
export function isWslBashLauncher(file, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return false
  const normalize = value => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
  const candidate = normalize(file)
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT
  if (typeof systemRoot === 'string' && systemRoot.trim() !== '') {
    for (const relative of ['System32', 'Sysnative']) {
      if (candidate === normalize(path.win32.join(systemRoot, relative, 'bash.exe'))) return true
    }
  }
  const aliasRoot = env.LOCALAPPDATA ?? env.LocalAppData
  return typeof aliasRoot === 'string' && aliasRoot.trim() !== ''
    && candidate === normalize(path.win32.join(aliasRoot, 'Microsoft', 'WindowsApps', 'bash.exe'))
}

/**
 * Map the model's workdir onto a Windows path. `D:/repo` and `/d/repo` both mean
 * `D:\repo`; a drive-less POSIX path has no Windows meaning and is rejected
 * instead of being resolved against whatever drive the harness happens to use.
 * @param raw - model-provided workdir, possibly empty.
 * @param cwd - authoritative session workspace.
 * @returns an absolute Windows directory path.
 */
export function resolveWorkdir(raw, cwd) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') {
    if (typeof cwd !== 'string' || cwd === '') {
      throw new CallArgumentError('no workdir was given and the session has no workspace directory; pass workdir.')
    }
    return path.win32.normalize(cwd)
  }

  const candidate = toWindowsPath(value)
  if (/^[A-Za-z]:(?![\\/])/.test(candidate)) {
    throw new CallArgumentError(`workdir is drive-relative: ${value}. Use ${candidate[0].toUpperCase()}:\\... instead.`)
  }
  if (/^[\\/]/.test(candidate) && !candidate.startsWith('\\\\') && !/^[A-Za-z]:/.test(candidate)) {
    throw new CallArgumentError(`workdir is a drive-less path: ${value}. Use D:/repo or /d/repo.`)
  }

  const hasSessionDir = typeof cwd === 'string' && cwd !== ''
  if (!path.win32.isAbsolute(candidate)) {
    if (!hasSessionDir) {
      throw new CallArgumentError(`workdir is relative and the session has no workspace directory: ${value}`)
    }
    return path.win32.normalize(path.win32.resolve(cwd, candidate))
  }
  return path.win32.normalize(candidate)
}

/**
 * Convert an MSYS absolute path (`/d/repo`, `/cygdrive/d/repo`) to a drive path.
 * @param value - a path from the model.
 * @returns the drive form, or the input unchanged.
 */
function toWindowsPath(value) {
  const match = /^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)/.exec(value)
  return match === null ? value : `${match[1].toUpperCase()}:${value.slice(match[0].length)}`
}

/**
 * Assert that a workdir exists and is a directory. `spawn` reports a missing cwd
 * and a missing executable with the same ENOENT, so this check keeps the message
 * unambiguous.
 * @param dir - absolute directory.
 * @returns the same directory.
 */
export function assertDirectory(dir) {
  let stat
  try {
    stat = fs.statSync(dir, { throwIfNoEntry: false })
  } catch (error) {
    throw new CallArgumentError(`workdir is not accessible: ${dir} (${errorMessage(error)})`)
  }
  if (stat === undefined) throw new CallArgumentError(`workdir does not exist: ${dir}`)
  if (!stat.isDirectory()) throw new CallArgumentError(`workdir is not a directory: ${dir}`)
  return dir
}

/**
 * Build the tool definition. Kept exportable so the argument and policy paths can
 * be exercised without a live Windows host.
 * @param ctx - plugin context.
 * @param bash - resolved bash executable.
 * @param settings - normalized settings.
 * @param toolName - registered name.
 * @returns a host tool definition.
 */
export function createDefinition(ctx, bash, settings, toolName = TOOL_NAME) {
  return {
    name: toolName,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      presentationMeta,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    presentCall,
    presentResult,
    async execute(args, exec) {
      return runCall(ctx, bash, settings, args, exec)
    },
  }
}

/**
 * Execute one bash call.
 * @param ctx - plugin context.
 * @param bash - resolved bash executable.
 * @param settings - normalized settings.
 * @param args - model arguments.
 * @param exec - tool run context.
 * @returns the canonical result value.
 */
async function runCall(ctx, bash, settings, args, exec) {
  const requested = args !== null && typeof args === 'object' ? args.timeoutMs : undefined
  const timeoutMs = requested === undefined
    ? settings.timeoutMs
    : (Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_TIMEOUT_MS)
      : undefined)
  if (timeoutMs === undefined) {
    return failure(refusal('INVALID_ARGUMENT', 'timeoutMs must be a positive number.'), settings.timeoutMs)
  }
  if (exec.signal?.aborted === true) {
    return failure(refusal('CANCELLED', 'the call was cancelled before it started.', { retry: 'never' }), timeoutMs)
  }

  try {
    assertKnownArguments(args)
    const source = readSource(args)
    refuseUnlessFullAccess(ctx, exec)
    const cwd = assertDirectory(resolveWorkdir(args.workdir, await sessionDirectory(ctx, exec)))
    const argv = source.command !== undefined
      ? [bash, '-c', source.command]
      : [bash, toBashPath(assertScript(source.scriptPath, cwd))]
    return await spawnBash(ctx, argv, cwd, timeoutMs, exec)
  } catch (error) {
    if (error instanceof CallArgumentError) return failure(refusal('INVALID_ARGUMENT', error.message), timeoutMs)
    if (error instanceof UnavailableError) {
      return failure(refusal('EXECUTOR_UNAVAILABLE', error.message, {
        retry: 'never',
        nextAction: 'Use pwsh for this command, or run it from a danger-full-access session.',
      }), timeoutMs)
    }
    return failure(refusal('INTERNAL_ERROR', `the bash tool failed before the command could run: ${errorMessage(error)}`, {
      effectState: 'unknown',
      retry: 'never',
      nextAction: 'This is a plugin defect; do not repeat the same call unchanged.',
    }), timeoutMs)
  }
}

/**
 * Reject arguments this tool does not read, naming the accepted ones. Without
 * this check an undeclared key disappears and the call still succeeds, which
 * reads to the model as "the parameter was honoured".
 * @param args - model arguments.
 */
function assertKnownArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new CallArgumentError('arguments must be an object.')
  }
  const unknown = Object.keys(args).filter(key => !KNOWN_ARGUMENTS.includes(key))
  if (unknown.length === 0) return

  let hint = `accepted arguments: ${KNOWN_ARGUMENTS.join(', ')}.`
  if (unknown.includes('run_in_background')) {
    hint = 'This tool runs in the foreground only and has no background mode.'
  } else if (unknown.includes('sandbox_permissions') || unknown.includes('justification')) {
    hint = 'This tool has no per-call permission arguments; the session policy decides whether it runs.'
  }
  const label = unknown.length === 1 ? 'unknown argument' : 'unknown arguments'
  throw new CallArgumentError(`${label}: ${unknown.join(', ')}. ${hint}`)
}

/**
 * Read and validate `command` / `script_path`.
 * @param args - model arguments.
 * @returns exactly one source.
 */
function readSource(args) {
  const command = typeof args.command === 'string' ? args.command : undefined
  const scriptPath = typeof args.script_path === 'string' && args.script_path.trim() !== ''
    ? args.script_path.trim()
    : undefined
  if (command === undefined && scriptPath === undefined) {
    throw new CallArgumentError('provide command or script_path.')
  }
  if (command !== undefined && scriptPath !== undefined) {
    throw new CallArgumentError('provide exactly one of command and script_path, not both.')
  }
  if (command !== undefined && command.trim() === '') throw new CallArgumentError('command must not be empty.')
  if (command !== undefined && command.length > MAX_COMMAND_LENGTH) {
    throw new CallArgumentError(
      `command is ${command.length} characters; Windows rejects command lines over ${MAX_COMMAND_LENGTH}. `
      + 'Write the script to a file and pass it as script_path.',
    )
  }
  return { command, scriptPath }
}

/**
 * Resolve a script path against the execution directory and require a real file.
 * @param script - model-provided path.
 * @param cwd - execution directory.
 * @returns an absolute Windows path.
 */
function assertScript(script, cwd) {
  const candidate = toWindowsPath(script)
  const absolute = path.win32.isAbsolute(candidate)
    ? path.win32.normalize(candidate)
    : path.win32.resolve(cwd, candidate)
  const stat = fs.statSync(absolute, { throwIfNoEntry: false })
  if (stat === undefined) throw new CallArgumentError(`script_path is not an existing file: ${absolute}`)
  if (!stat.isFile()) throw new CallArgumentError(`script_path is not a file: ${absolute}`)
  return absolute
}

/**
 * MSYS bash reads `D:\x\y.sh` as an escape sequence in some positions; forward
 * slashes are unambiguous and accepted by the MSYS runtime.
 * @param file - absolute Windows path.
 * @returns the same path with forward slashes.
 */
function toBashPath(file) {
  return file.replaceAll('\\', '/')
}

/**
 * Refuse to run outside full access. This bundle does not ship a sandbox shim, so
 * running anyway would silently bypass the session's confinement.
 * @param ctx - plugin context.
 * @param exec - tool run context.
 */
function refuseUnlessFullAccess(ctx, exec) {
  const policy = ctx.get('sandboxPolicy')?.resolve({ session: exec.agent?.session })
  if (policy === undefined || policy.mode === FULL_ACCESS) return
  throw new UnavailableError(
    `this tool runs only in ${FULL_ACCESS}; the session sandbox is "${policy.mode}".`,
  )
}

/**
 * Resolve the authoritative session directory.
 * @param ctx - plugin context.
 * @param exec - tool run context.
 * @returns the absolute session workspace, when the host exposes one.
 */
async function sessionDirectory(ctx, exec) {
  const service = ctx.get('workingDirectory')
  if (service === undefined || service === null || exec.agent === undefined) return undefined
  const dir = await service.ensure(exec.agent, exec.signal)
  return typeof dir === 'string' && dir !== '' ? dir : undefined
}

/**
 * Spawn bash and settle it into the canonical result.
 * @param ctx - plugin context.
 * @param argv - executable and arguments.
 * @param cwd - execution directory.
 * @param timeoutMs - kill deadline.
 * @param exec - tool run context.
 * @returns the canonical result value.
 */
async function spawnBash(ctx, argv, cwd, timeoutMs, exec) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = exec.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout])

  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
        stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
      },
      graceMs: GRACE_MS,
      signal,
      env: SHELL_ENV,
    })
  } catch (error) {
    return failure(refusal('SPAWN_FAILED', `cannot start bash: ${errorMessage(error)}`, {
      retry: 'never',
      nextAction: 'bash could not be started; this is an installation or bashPath problem, not a command problem.',
    }), timeoutMs)
  }

  let outcome
  let engineError
  try {
    outcome = await handle.done
  } catch (error) {
    engineError = errorMessage(error)
  }

  const timedOut = timeout.aborted && exec.signal?.aborted !== true
  return withStatus({
    exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
    signal: typeof outcome?.signal === 'string' ? outcome.signal : null,
    timedOut,
    timeoutMs,
    stdout: readStream(handle.collected?.stdout),
    stderr: readStream(handle.collected?.stderr),
    ...(engineError === undefined ? {} : {
      failure: refusal('SUBPROCESS_ERROR', engineError, { effectState: 'unknown', retry: 'never' }),
    }),
  })
}

/**
 * Read one collected stream.
 * @param reader - collected output reader.
 * @returns `{ text, truncated, spillPath? }`.
 */
function readStream(reader) {
  let value
  try {
    value = reader?.readFrom?.(0)
  } catch {
    value = undefined
  }
  if (value === undefined || value === null) return { text: '', truncated: false }
  return {
    text: typeof value.text === 'string' ? value.text : '',
    truncated: value.lossy === true,
    ...(typeof value.spillPath === 'string' ? { spillPath: value.spillPath } : {}),
  }
}

/**
 * Describe a failure: `effectState` says whether the command could have run, and
 * `retry` says whether repeating the call could help.
 * @param code - failure class understood by the model and the UI.
 * @param message - model-facing reason.
 * @param options - overrides for `effectState` (default `none`), `retry`
 *   (default `after-input-change`) and `nextAction`.
 * @returns the failure payload.
 */
function refusal(code, message, options = {}) {
  return {
    code,
    message,
    effectState: options.effectState ?? 'none',
    retry: options.retry ?? 'after-input-change',
    ...(options.nextAction === undefined ? {} : { nextAction: options.nextAction }),
  }
}

/**
 * Build a result that carries no command result at all. Failure is data: the model
 * sees the reason and can switch shells or fix its arguments without a thrown tool
 * error, and the value still satisfies `output.schema`.
 * @param payload - failure payload.
 * @param timeoutMs - budget that applied.
 * @returns a canonical failed value.
 */
function failure(payload, timeoutMs) {
  return withStatus({
    exitCode: null,
    signal: null,
    timedOut: false,
    timeoutMs,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    failure: payload,
  })
}

/**
 * Derive `status`. Only a clean exit is completed: a timeout, a signal or an engine
 * failure makes the call failed even when the process exited with 0.
 * @param value - result value without `status`.
 * @returns the same value with `status` first.
 */
function withStatus(value) {
  const completed = value.exitCode === 0
    && value.timedOut !== true
    && value.signal === null
    && value.failure === undefined
  return { status: completed ? 'completed' : 'failed', ...value }
}

/**
 * Render one result for the model.
 * @param value - canonical result.
 * @returns model-facing text.
 */
export function renderResult(value) {
  if (value === null || typeof value !== 'object') return '(no result)'
  const parts = []
  const stdout = typeof value.stdout?.text === 'string' ? value.stdout.text : ''
  const stderr = typeof value.stderr?.text === 'string' ? value.stderr.text : ''
  const failure = value.failure !== null && typeof value.failure === 'object' ? value.failure : undefined
  if (stdout.trimEnd() !== '') parts.push(stdout.trimEnd())
  if (stderr.trim() !== '') parts.push(`[stderr]\n${stderr.trimEnd()}`)
  if (parts.length === 0 && failure === undefined) parts.push('(no output)')
  for (const stream of ['stdout', 'stderr']) {
    const entry = value[stream]
    if (entry?.truncated === true) {
      parts.push(`[${stream} truncated; full output: ${typeof entry.spillPath === 'string' ? entry.spillPath : 'unavailable'}]`)
    }
  }
  if (failure !== undefined) {
    const nextAction = typeof failure.nextAction === 'string' && failure.nextAction !== '' ? ` ${failure.nextAction}` : ''
    parts.push(`[${failure.code}; effects: ${failure.effectState}; retry: ${failure.retry}] ${failure.message}${nextAction}`)
  }
  if (value.timedOut === true) parts.push(`[timed out after ${value.timeoutMs}ms; the whole process tree was stopped]`)
  if (typeof value.signal === 'string' && value.signal !== '') parts.push(`[killed by signal: ${value.signal}]`)
  if (typeof value.exitCode === 'number') parts.push(`[exit code: ${value.exitCode}]`)
  return parts.join('\n')
}

/**
 * Title for the terminal card: the command's first line, or the script being run.
 * @param args - model arguments.
 * @returns a single-line title, empty when the call has no source.
 */
function callTitle(args) {
  const command = typeof args?.command === 'string' ? args.command.trim() : ''
  const script = typeof args?.script_path === 'string' ? args.script_path.trim() : ''
  const raw = command !== '' ? command : script !== '' ? `bash ${script}` : ''
  const firstLine = raw.split(/\r?\n/, 1)[0].trim()
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine
}

/**
 * Render the pending call as a terminal card. Presentation is derived from the
 * arguments alone, so the host can replay it without an execution.
 * @param args - model arguments.
 * @returns a terminal call view, or undefined when there is nothing to show.
 */
function presentCall(args) {
  const title = callTitle(args)
  if (title === '') return undefined
  const view = { card: 'terminal', title }
  const description = typeof args?.description === 'string' ? args.description.trim() : ''
  if (description !== '') view.description = description
  const workdir = typeof args?.workdir === 'string' ? args.workdir.trim() : ''
  if (workdir !== '') view.cwd = workdir
  return view
}

/**
 * Project the exit status onto the result meta, which is what `presentResult` can
 * read back: the rendered content is the model-facing text, not the status.
 * @param _args - model arguments.
 * @param value - canonical result.
 * @returns the persisted presentation payload.
 */
function presentationMeta(_args, value) {
  return {
    terminal: {
      exitCode: typeof value?.exitCode === 'number' ? value.exitCode : null,
      signal: typeof value?.signal === 'string' && value.signal !== '' ? value.signal : null,
    },
  }
}

/**
 * Render the completed call as a terminal card with its output and exit pill.
 * @param _args - model arguments.
 * @param result - host tool result.
 * @returns a terminal result view.
 */
function presentResult(_args, result) {
  const output = Array.isArray(result?.content)
    ? result.content
      .map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(text => text !== '')
      .join('\n')
    : ''
  const view = { card: 'terminal' }
  if (output !== '') view.output = output
  const exitCode = result?.meta?.terminal?.exitCode
  const signal = result?.meta?.terminal?.signal
  if (typeof exitCode === 'number') view.exitCode = exitCode
  else if (typeof signal === 'string' && signal !== '') view.signal = signal
  return view
}

/**
 * Build the prompt guidance for this tool.
 * @param toolName - registered tool name.
 * @param settings - normalized settings.
 * @returns prompt section text.
 */
function guidance(toolName, settings) {
  const lines = [
    '### Shell choice on Windows',
    '',
    `\`${toolName}\` runs GNU bash (Git Bash / MSYS2) over the Windows filesystem; \`pwsh\` runs PowerShell.`,
    `- Prefer \`${toolName}\` for POSIX work: pipelines, grep/sed/awk/find, shell scripts, git, make.`,
    '- Use `pwsh` for Windows-native objects: registry, services, scheduled tasks, WMI/CIM, .NET APIs.',
    `- Each \`${toolName}\` call is a fresh shell. Pass \`workdir\` instead of \`cd\`; it accepts \`D:/repo\` or \`/d/repo\`.`,
    '- Inside a command use MSYS paths (`/d/repo`); quote paths that contain spaces.',
    `- Write quoting-heavy or long scripts to a file and pass \`script_path\`; heredocs, backslashes and nested quotes inside one \`command\` are where calls break.`,
    '- Foreground only: no `run_in_background` and no job id, so a server or watcher holds the call until `timeoutMs`.',
    '- Output is truncated to its tail; check the truncation note before parsing stdout as complete.',
    '- `[exit code: N]` is the command result, not a tool failure; `[stderr]` is part of the output.',
    '- A `[CODE; effects: ...; retry: ...]` line means bash produced no command result; read `effects` before retrying.',
  ]
  if (settings.extraGuidance !== '') lines.push('', settings.extraGuidance)
  return lines.join('\n')
}

/**
 * Prompt section published when bash cannot be resolved, so the model learns it has
 * no bash instead of assuming one exists.
 * @param error - why resolution failed.
 * @returns prompt section text.
 */
function unavailable(error) {
  return [
    '### bash is unavailable on this host',
    '',
    `No Git Bash was found, so this bundle did not register \`bash\`: ${error}`,
    'Use `pwsh` for shell work, and do not describe bash commands as having run.',
  ].join('\n')
}

/**
 * Test one path for being an existing regular file.
 * @param file - candidate path.
 * @returns whether the file exists.
 */
function isFile(file) {
  try {
    return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

/**
 * Deduplicate Windows paths case-insensitively, preserving order.
 * @param values - candidate paths.
 * @returns unique paths.
 */
function dedupe(values) {
  const seen = new Set()
  return values.filter(value => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Read a human-readable message from an unknown thrown value.
 * @param error - thrown value.
 * @returns message text.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
