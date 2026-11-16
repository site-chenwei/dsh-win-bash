import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  Config,
  apply,
  createDefinition,
  isWslBashLauncher,
  renderResult,
  resolveBash,
  resolveWorkdir,
} from '../index.js'

const SIGNAL = new AbortController().signal
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const SETTINGS = { bashPath: undefined, timeoutMs: 120_000, extraGuidance: '' }

/**
 * Build the smallest context the tool body touches.
 * @param policy - sandbox mode the session reports.
 * @param onSpawn - called for every spawn attempt.
 * @returns a stub plugin context.
 */
function stubContext(policy, onSpawn = () => { throw new Error('spawn must not run here') }) {
  return {
    subprocess: { spawn: onSpawn },
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: policy }) }
      if (name === 'workingDirectory') return { ensure: async () => 'C:\\ws' }
      return undefined
    },
  }
}

/**
 * Build a subprocess handle around one settled outcome.
 * @param outcome - value `done` resolves to, or an error it rejects with.
 * @param streams - collected stream texts.
 * @returns a spawn result.
 */
function handleFor(outcome, streams = { stdout: 'ok\n', stderr: '' }) {
  const reader = text => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return {
    done: outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
    collected: { stdout: reader(streams.stdout), stderr: reader(streams.stderr) },
  }
}

/**
 * Run one call with directory checks stubbed out, so the post-spawn path can be
 * exercised on a host that has no Windows drive.
 * @param spawn - spawn implementation.
 * @param args - model arguments.
 * @returns the canonical result value.
 */
async function executeWithoutWindows(spawn, args) {
  const realStat = fs.statSync
  fs.statSync = () => ({ isDirectory: () => true, isFile: () => true })
  try {
    const tool = createDefinition(stubContext('danger-full-access', spawn), BASH, SETTINGS)
    return await tool.execute(args, { signal: SIGNAL, agent: {} })
  } finally {
    fs.statSync = realStat
  }
}

test('resolveWorkdir maps MSYS and drive paths', () => {
  assert.equal(resolveWorkdir('D:/repo', 'C:\\ws'), 'D:\\repo')
  assert.equal(resolveWorkdir('/d/repo', 'C:\\ws'), 'D:\\repo')
  assert.equal(resolveWorkdir('/cygdrive/d/repo', 'C:\\ws'), 'D:\\repo')
  assert.equal(resolveWorkdir('sub/dir', 'C:\\ws'), 'C:\\ws\\sub\\dir')
  assert.equal(resolveWorkdir(undefined, 'C:\\ws'), 'C:\\ws')
  assert.equal(resolveWorkdir('\\\\server\\share', 'C:\\ws'), '\\\\server\\share\\')
})

test('resolveWorkdir rejects ambiguous directories', () => {
  assert.throws(() => resolveWorkdir('/tmp', 'C:\\ws'), /drive-less path/)
  assert.throws(() => resolveWorkdir('D:child', 'C:\\ws'), /drive-relative/)
  assert.throws(() => resolveWorkdir('sub', undefined), /no workspace directory/)
})

test('isWslBashLauncher rejects the WSL entry points only', () => {
  const env = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\b\\AppData\\Local' }
  assert.equal(isWslBashLauncher('C:\\Windows\\System32\\bash.exe', env, 'win32'), true)
  assert.equal(isWslBashLauncher('c:/windows/system32/bash.exe', env, 'win32'), true)
  assert.equal(isWslBashLauncher('C:\\Users\\b\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe', env, 'win32'), true)
  assert.equal(isWslBashLauncher(BASH, env, 'win32'), false)
})

test('an explicit bashPath never falls back to another installation', () => {
  const result = resolveBash({ bashPath: 'C:\\missing\\bash.exe' }, {}, 'win32')
  assert.match(result.error, /not an existing file/)
})

test('renderResult keeps stderr, truncation, timeout and exit status distinct', () => {
  const text = renderResult({
    status: 'failed',
    exitCode: 3,
    signal: 'SIGTERM',
    timedOut: true,
    timeoutMs: 1_000,
    stdout: { text: 'hi\n', truncated: false },
    stderr: { text: 'warn\n', truncated: true, spillPath: 'C:\\tmp\\spill' },
    failure: { code: 'SUBPROCESS_ERROR', message: 'boom', effectState: 'unknown', retry: 'never' },
  })
  assert.match(text, /^hi\n\[stderr\]\nwarn/)
  assert.match(text, /\[stderr truncated; full output: C:\\tmp\\spill\]/)
  assert.match(text, /\[SUBPROCESS_ERROR; effects: unknown; retry: never\] boom/)
  assert.match(text, /\[timed out after 1000ms/)
  assert.match(text, /\[killed by signal: SIGTERM\]/)
  assert.match(text, /\[exit code: 3\]/)
  assert.equal(renderResult({ status: 'completed', exitCode: 0, signal: null, timedOut: false, timeoutMs: 1, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }), '(no output)\n[exit code: 0]')
})

test('a refusal renders its code, effects and retry without inventing output', () => {
  const text = renderResult({
    status: 'failed',
    exitCode: null,
    signal: null,
    timedOut: false,
    timeoutMs: 120_000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    failure: {
      code: 'INVALID_ARGUMENT',
      message: 'provide command or script_path.',
      effectState: 'none',
      retry: 'after-input-change',
      nextAction: 'accepted arguments: command, script_path.',
    },
  })
  assert.equal(text, '[INVALID_ARGUMENT; effects: none; retry: after-input-change] provide command or script_path. accepted arguments: command, script_path.')
})

test('a restricted session is refused before anything spawns', async () => {
  const tool = createDefinition(stubContext('workspace-write'), BASH, SETTINGS)
  const result = await tool.execute({ command: 'echo hi' }, { signal: SIGNAL, agent: {} })
  assert.equal(result.status, 'failed')
  assert.equal(result.failure.code, 'EXECUTOR_UNAVAILABLE')
  assert.equal(result.failure.effectState, 'none')
  assert.equal(result.failure.retry, 'never')
  assert.match(result.failure.message, /runs only in danger-full-access/)
  assert.match(result.failure.message, /workspace-write/)
})

test('unknown arguments are rejected instead of silently dropped', async () => {
  const tool = createDefinition(stubContext('danger-full-access'), BASH, SETTINGS)
  const background = await tool.execute(
    { command: 'npm run dev', run_in_background: true },
    { signal: SIGNAL, agent: {} },
  )
  assert.equal(background.status, 'failed')
  assert.equal(background.failure.code, 'INVALID_ARGUMENT')
  assert.equal(background.failure.effectState, 'none')
  assert.equal(background.failure.retry, 'after-input-change')
  assert.match(background.failure.message, /unknown argument: run_in_background/)
  assert.match(background.failure.message, /foreground only/)

  const permission = await tool.execute(
    { command: 'rm -rf build', sandbox_permissions: 'danger-full-access', justification: 'clean' },
    { signal: SIGNAL, agent: {} },
  )
  assert.match(permission.failure.message, /unknown arguments: sandbox_permissions, justification/)
  assert.match(permission.failure.message, /no per-call permission arguments/)

  const other = await tool.execute({ command: 'ls', depth: 2 }, { signal: SIGNAL, agent: {} })
  assert.match(other.failure.message, /accepted arguments: description, command, script_path, workdir, timeoutMs/)
})

test('source validation runs before execution', async () => {
  const tool = createDefinition(stubContext('workspace-write'), BASH, SETTINGS)
  const cases = [
    [{}, /provide command or script_path/],
    [{ command: '', script_path: 'x.sh' }, /exactly one/],
    [{ command: 'echo hi', script_path: 'x.sh' }, /exactly one/],
    [{ command: '   ' }, /must not be empty/],
    [{ command: 'x'.repeat(30_001) }, /script_path/],
    [{ command: 'echo hi', timeoutMs: -1 }, /timeoutMs must be a positive number/],
  ]
  for (const [args, expected] of cases) {
    const result = await tool.execute(args, { signal: SIGNAL, agent: {} })
    assert.equal(result.status, 'failed')
    assert.match(result.failure.message, expected)
  }
})

test('a full-access call with a missing workdir fails clearly and never spawns', async () => {
  const tool = createDefinition(stubContext('danger-full-access'), BASH, SETTINGS)
  const result = await tool.execute({ command: 'ls', workdir: 'C:\\definitely-missing-9d3f' }, { signal: SIGNAL, agent: {} })
  assert.equal(result.status, 'failed')
  assert.equal(result.failure.code, 'INVALID_ARGUMENT')
  assert.match(result.failure.message, /workdir does not exist/)
})

test('a cancelled call reports CANCELLED and never spawns', async () => {
  const controller = new AbortController()
  controller.abort()
  const tool = createDefinition(stubContext('danger-full-access'), BASH, SETTINGS)
  const result = await tool.execute({ command: 'ls' }, { signal: controller.signal, agent: {} })
  assert.equal(result.failure.code, 'CANCELLED')
  assert.equal(result.failure.retry, 'never')
})

test('a clean exit is completed', async () => {
  const result = await executeWithoutWindows(
    () => handleFor({ exitCode: 0, signal: null }),
    { command: 'echo ok' },
  )
  assert.equal(result.status, 'completed')
  assert.equal(result.exitCode, 0)
  assert.equal(result.failure, undefined)
  assert.equal(renderResult(result), 'ok\n[exit code: 0]')
})

test('a non-zero exit is failed but not a failure payload', async () => {
  const result = await executeWithoutWindows(
    () => handleFor({ exitCode: 2, signal: null }),
    { command: 'exit 2', workdir: 'D:/repo' },
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.exitCode, 2)
  assert.equal(result.failure, undefined)
  assert.equal(renderResult(result), 'ok\n[exit code: 2]')
})

test('a broken output stream keeps the run and marks effects unknown', async () => {
  const result = await executeWithoutWindows(
    () => handleFor(new Error('stream broke')),
    { command: 'make' },
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.failure.code, 'SUBPROCESS_ERROR')
  assert.equal(result.failure.effectState, 'unknown')
  assert.equal(result.failure.retry, 'never')
  assert.match(renderResult(result), /\[SUBPROCESS_ERROR; effects: unknown; retry: never\] stream broke/)
})

test('the terminal card carries the command, its description and the exit status', () => {
  const tool = createDefinition(stubContext('danger-full-access'), BASH, SETTINGS)

  assert.deepEqual(tool.presentCall({ command: 'git status', description: 'Show repo status', workdir: 'D:/repo' }), {
    card: 'terminal',
    title: 'git status',
    description: 'Show repo status',
    cwd: 'D:/repo',
  })
  assert.equal(tool.presentCall({ command: 'echo a\necho b' }).title, 'echo a')
  assert.equal(tool.presentCall({ script_path: 'C:\\repo\\build.sh', workdir: 'C:\\repo' }).title, 'bash C:\\repo\\build.sh')
  assert.equal(tool.presentCall({ workdir: 'D:/repo' }), undefined)

  const value = { status: 'failed', exitCode: 2, signal: null, timedOut: false, timeoutMs: 120_000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
  const meta = tool.output.presentationMeta({}, value)
  assert.deepEqual(meta, { terminal: { exitCode: 2, signal: null } })
  assert.deepEqual(
    tool.presentResult({}, { content: [{ type: 'text', text: 'ok\n[exit code: 2]' }], isError: false, meta }),
    { card: 'terminal', output: 'ok\n[exit code: 2]', exitCode: 2 },
  )
  assert.deepEqual(
    tool.presentResult({}, { content: [], isError: true, meta: { terminal: { exitCode: null, signal: 'SIGKILL' } } }),
    { card: 'terminal', signal: 'SIGKILL' },
  )
})

test('the definition exposes one model-facing text block', () => {
  const tool = createDefinition(stubContext('danger-full-access'), BASH, SETTINGS)
  assert.equal(tool.name, 'win_bash')
  assert.equal(typeof tool.parameters.properties.command, 'object')
  const blocks = tool.output.render({}, {
    status: 'completed',
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutMs: 120_000,
    stdout: { text: 'ok\n', truncated: false },
    stderr: { text: '', truncated: false },
  })
  assert.deepEqual(blocks, [{ type: 'text', text: 'ok\n[exit code: 0]' }])
})

/**
 * Build a plugin context that records what `apply` registers and publishes.
 * @returns the context and the recorded effects.
 */
function recordingContext() {
  const seen = { registrations: [], sections: [] }
  return {
    seen,
    ctx: {
      logger: { info() {}, warn() {} },
      get: () => undefined,
      effect(factory) {
        factory()
      },
      tools: {
        register(definition) {
          seen.registrations.push(definition)
          return () => {}
        },
      },
      systemPrompt: {
        getSectionOrder: name => (name === 'TOOL_BASH' ? 1000 : undefined),
        section(section) {
          seen.sections.push(section)
          return () => {}
        },
      },
    },
  }
}

/**
 * Run a callback with `process.platform` reporting Windows and every path check
 * stubbed, so `apply` can be exercised off a Windows box.
 * @param fn - callback to run.
 * @param fileExists - whether stubbed path checks report a regular file.
 * @returns whatever the callback returns.
 */
async function onFakeWindows(fn, fileExists) {
  const realStat = fs.statSync
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  fs.statSync = () => (fileExists ? { isDirectory: () => true, isFile: () => true } : undefined)
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    return await fn()
  } finally {
    fs.statSync = realStat
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
}

test('apply registers the tool and publishes the guidance section', async () => {
  const { ctx, seen } = recordingContext()
  await onFakeWindows(() => apply(ctx, { bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe' }), true)

  assert.equal(seen.registrations.length, 1)
  assert.equal(seen.registrations[0].name, 'win_bash')
  assert.equal(typeof seen.registrations[0].presentCall, 'function')
  assert.equal(typeof seen.registrations[0].output.presentationMeta, 'function')
  assert.equal(seen.sections.length, 1)
  assert.equal(seen.sections[0].name, 'dsh-win-bash:guidance')
  assert.equal(seen.sections[0].order, 1000)
  assert.equal(seen.sections[0].interpolate, false)
  assert.match(seen.sections[0].text, /script_path/)
  assert.match(seen.sections[0].text, /Foreground only/)
})

test('an unusable bashPath publishes why bash is missing instead of staying silent', async () => {
  const { ctx, seen } = recordingContext()
  await onFakeWindows(() => apply(ctx, { bashPath: 'C:\\missing\\bash.exe' }), false)

  assert.equal(seen.registrations.length, 0)
  assert.equal(seen.sections.length, 1)
  assert.equal(seen.sections[0].name, 'dsh-win-bash:unavailable')
  assert.match(seen.sections[0].text, /not an existing file/)
  assert.match(seen.sections[0].text, /pwsh/)
})

test('the bundle patch imports the package by its published name', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const declared = patch.match(/^\s*name:\s*"?([^"\s]+)"?\s*$/m)

  assert.ok(declared, 'cordis.patch.yml must declare the entry name')
  assert.equal(declared[1], pkg.name)
})

test('a taken win_bash name falls back to bash and the guidance follows it', async () => {
  const seen = { registrations: [], sections: [] }
  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    effect(factory) { factory() },
    tools: {
      register(definition) {
        if (definition.name === 'win_bash') throw new Error('tool "win_bash" is already registered')
        seen.registrations.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      getSectionOrder: () => 1000,
      section(section) {
        seen.sections.push(section)
        return () => {}
      },
    },
  }

  await onFakeWindows(() => apply(ctx, { bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe' }), true)

  assert.equal(seen.registrations.length, 1)
  assert.equal(seen.registrations[0].name, 'bash')
  assert.match(seen.sections[0].text, /`bash` runs GNU bash/)
})

test('the config schema accepts the documented shape and names typos', () => {
  const validate = Config['~standard'].validate

  assert.equal(validate({}).value.timeoutMs, undefined)
  assert.equal(validate({ timeoutMs: 120_000, bashPath: 'C:\\Git\\bin\\bash.exe' }).value.timeoutMs, 120_000)
  assert.match(validate({ bashpath: 'C:\\Git\\bin\\bash.exe' }).issues[0].message, /unknown config key "bashpath"/)
  assert.match(validate({ timeoutMs: '120000' }).issues[0].message, /must be a finite number/)
  assert.match(validate({ extraGuidance: 5 }).issues[0].message, /must be a string/)
  assert.match(validate('nope').issues[0].message, /config must be an object/)
})
