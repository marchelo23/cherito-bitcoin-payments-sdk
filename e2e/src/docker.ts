import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { COMPOSE_FILE, COMPOSE_PROJECT, E2E_ROOT, LOG_DIR } from './env.js'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? E2E_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`${command} ${args.join(' ')} timed out`))
    }, options.timeoutMs ?? 600_000)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (!options.quiet) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (!options.quiet) process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

export async function compose(args: string[], options: { quiet?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
  return run('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, ...args], options)
}

export async function composeOrThrow(args: string[], options: { quiet?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
  const result = await compose(args, options)
  if (result.code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed (${result.code}): ${result.stderr.slice(-800)}`)
  }
  return result
}

export async function assertDockerAvailable(): Promise<void> {
  const result = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true, timeoutMs: 60_000 })
  if (result.code !== 0) {
    throw new Error(
      `Docker daemon is not reachable. Start it first (colima start).\n${result.stderr.slice(-400)}`,
    )
  }
}

export async function up(services: string[] = []): Promise<void> {
  await composeOrThrow(['up', '-d', '--build', '--wait', ...services], { timeoutMs: 900_000 })
}

export async function upNoWait(services: string[] = []): Promise<void> {
  await composeOrThrow(['up', '-d', '--build', ...services], { timeoutMs: 900_000 })
}

export async function stopService(service: string): Promise<void> {
  await composeOrThrow(['stop', '-t', '20', service], { quiet: true })
}

export async function startService(service: string): Promise<void> {
  await composeOrThrow(['start', service], { quiet: true })
}

export async function restartService(service: string): Promise<void> {
  await composeOrThrow(['restart', '-t', '20', service], { quiet: true })
}

export async function exec(service: string, command: string[], asRoot = false): Promise<RunResult> {
  const userArgs = asRoot ? ['-u', '0'] : []
  return compose(['exec', '-T', ...userArgs, service, ...command], { quiet: true })
}

export async function execOrThrow(service: string, command: string[], asRoot = false): Promise<string> {
  const result = await exec(service, command, asRoot)
  if (result.code !== 0) {
    throw new Error(`exec ${service} ${command.join(' ')} failed (${result.code}): ${result.stderr.slice(-400)}`)
  }
  return result.stdout
}

export async function serviceLogs(service: string, tail = 'all'): Promise<string> {
  const result = await compose(['logs', '--no-color', '--tail', tail, service], { quiet: true })
  return result.stdout + result.stderr
}

export async function collectLogs(label: string): Promise<string> {
  const dir = resolve(LOG_DIR, label)
  await mkdir(dir, { recursive: true })
  const services = ['bitcoind', 'lnd-merchant', 'lnd-payer', 'gateway', 'merchant-receiver']
  for (const service of services) {
    const logs = await serviceLogs(service)
    await writeFile(resolve(dir, `${service}.log`), logs, 'utf8')
  }
  return dir
}

export async function down(): Promise<void> {
  await compose(['down', '-v', '--remove-orphans', '-t', '20'], { quiet: true, timeoutMs: 300_000 })
}
