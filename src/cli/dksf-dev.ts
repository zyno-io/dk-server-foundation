#!/usr/bin/env node

import { ChildProcess, spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { setTimeout as sleep } from 'timers/promises';

process.env.APP_ENV = process.env.APP_ENV || 'development';

function findProjectRoot(): string {
    let dir = process.cwd();
    while (true) {
        if (existsSync(join(dir, 'package.json'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) {
            console.error('Could not find package.json in any parent directory');
            process.exit(1);
        }
        dir = parent;
    }
}

const projectDir = findProjectRoot();
const tscPath = require.resolve('typescript/bin/tsc');

// --- Dev state coordination ---

const projectHash = createHash('md5').update(projectDir).digest('hex').substring(0, 12);
const devLockFile = join(tmpdir(), `dksf-dev-${projectHash}.lock`);
const devStateFile = join(tmpdir(), `dksf-dev-${projectHash}.json`);

interface DevState {
    ready: boolean;
    pids: number[];
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readDevState(): DevState | null {
    try {
        return JSON.parse(readFileSync(devStateFile, 'utf-8'));
    } catch {
        return null;
    }
}

function writeDevState(state: DevState): void {
    writeFileSync(devStateFile, JSON.stringify(state));
}

function registerDevPid(): void {
    const state = readDevState() ?? { ready: true, pids: [] };
    state.pids = state.pids.filter(isPidAlive);
    if (!state.pids.includes(process.pid)) state.pids.push(process.pid);
    writeDevState(state);
}

function unregisterDevPid(): void {
    const state = readDevState();
    if (!state) return;
    state.pids = state.pids.filter(p => p !== process.pid && isPidAlive(p));
    if (state.pids.length === 0) {
        try {
            unlinkSync(devStateFile);
        } catch {
            // ignore
        }
    } else {
        writeDevState(state);
    }
}

function isDevRunning(): boolean {
    const state = readDevState();
    return !!state?.ready && state.pids.some(isPidAlive);
}

function tryAcquireBuildLock(retries = 5): boolean {
    if (retries <= 0) return false;
    try {
        writeFileSync(devLockFile, String(process.pid), { flag: 'wx' });
        return true;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
            const pid = parseInt(readFileSync(devLockFile, 'utf-8'));
            if (!isPidAlive(pid)) {
                unlinkSync(devLockFile);
                return tryAcquireBuildLock(retries - 1);
            }
        } catch {
            return tryAcquireBuildLock(retries - 1);
        }
        return false;
    }
}

function releaseBuildLock(): void {
    try {
        unlinkSync(devLockFile);
    } catch {
        // ignore
    }
}

// --- Core operations ---

function extractTsconfigArg(args: string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-p' || args[i] === '--tsconfig') {
            const val = args[i + 1];
            args.splice(i, 2);
            return val;
        }
        if (args[i].startsWith('-p=') || args[i].startsWith('--tsconfig=')) {
            const val = args[i].split('=', 2)[1];
            args.splice(i, 1);
            return val;
        }
    }
    return undefined;
}

function clean(): void {
    rmSync(join(projectDir, 'dist'), { recursive: true, force: true });
}

function tsc(tsconfig: string): void {
    const result = spawnSync(process.execPath, [tscPath, '-p', tsconfig], {
        stdio: 'inherit',
        cwd: projectDir
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
}

function startTscWatchWithReadySignal(tsconfig: string): { child: ChildProcess; ready: Promise<void> } {
    const child = spawn(process.execPath, [tscPath, '-w', '--preserveWatchOutput', '-p', tsconfig], {
        stdio: ['inherit', 'pipe', 'inherit'],
        cwd: projectDir
    });

    const ready = new Promise<void>((resolve, reject) => {
        let resolved = false;
        child.stdout!.on('data', (data: Buffer) => {
            process.stdout.write(data);
            if (!resolved && data.toString().includes('Watching for file changes')) {
                resolved = true;
                resolve();
            }
        });
        child.on('close', code => {
            if (!resolved) reject(new Error(`tsc exited with code ${code}`));
        });
    });

    return { child, ready };
}

async function performLockedWatchBuild(tsconfig: string): Promise<ChildProcess> {
    console.log('Starting dev build...');
    clean();
    const { child, ready } = startTscWatchWithReadySignal(tsconfig);
    await ready;
    console.log('Dev build ready.');
    writeDevState({ ready: true, pids: [] });
    releaseBuildLock();
    return child;
}

// Returns tsc watch child process if this process is the builder, null otherwise
async function ensureDevBuild(tsconfig: string): Promise<ChildProcess | null> {
    if (isDevRunning()) {
        console.log('Using existing dev build from another process.');
        return null;
    }

    if (tryAcquireBuildLock()) {
        return performLockedWatchBuild(tsconfig);
    }

    // Wait for another builder to finish
    console.log('Waiting for another dksf-dev process to finish building...');
    while (true) {
        await sleep(200);
        if (readDevState()?.ready) {
            console.log('Build ready.');
            return null;
        }
        try {
            const pid = parseInt(readFileSync(devLockFile, 'utf-8'));
            if (!isPidAlive(pid)) {
                if (tryAcquireBuildLock()) {
                    return performLockedWatchBuild(tsconfig);
                }
            }
        } catch {
            if (readDevState()?.ready) return null;
            if (tryAcquireBuildLock()) {
                return performLockedWatchBuild(tsconfig);
            }
        }
    }
}

// --- Subcommands ---

function cmdClean(): void {
    clean();
}

function cmdBuild(args: string[]): void {
    const watch = args.includes('--watch');
    const tsconfig = extractTsconfigArg(args) ?? 'tsconfig.json';
    console.log('Building...');
    clean();
    if (watch) {
        const child = spawn(process.execPath, [tscPath, '-w', '--preserveWatchOutput', '-p', tsconfig], {
            stdio: 'inherit',
            cwd: projectDir
        });
        process.on('SIGINT', () => {});
        process.on('SIGTERM', () => child.kill('SIGTERM'));
        child.on('close', code => process.exit(code ?? 0));
    } else {
        tsc(tsconfig);
        console.log('Build complete.');
    }
}

async function cmdRun(args: string[]): Promise<void> {
    const ddIdx = args.indexOf('--');
    const ownArgs = ddIdx >= 0 ? args.slice(0, ddIdx) : args;
    const childArgs = ddIdx >= 0 ? args.slice(ddIdx + 1) : ['server:start'];

    const debug = ownArgs.includes('--debug');
    const tsconfig = extractTsconfigArg(ownArgs) ?? 'tsconfig.json';
    const script = ownArgs.find(a => !a.startsWith('-')) ?? '.';

    const tscChild = await ensureDevBuild(tsconfig);
    registerDevPid();
    process.on('exit', unregisterDevPid);

    const nodeArgs = ['--enable-source-maps', '--watch', '--watch-preserve-output'];

    const port = process.env.PORT;
    const inspectFlag = debug ? '--inspect-brk' : '--inspect';
    nodeArgs.push(port ? `${inspectFlag}=${parseInt(port) + 1000}` : inspectFlag);

    nodeArgs.push(script, ...childArgs);

    const child = spawn(process.execPath, nodeArgs, {
        stdio: 'inherit',
        cwd: projectDir
    });
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {
        child.kill('SIGTERM');
        tscChild?.kill('SIGTERM');
    });
    child.on('close', code => {
        tscChild?.kill();
        process.exit(code ?? 0);
    });
}

function cmdMigrate(args: string[]): void {
    const debug = args.includes('--debug');
    const tsconfig = extractTsconfigArg(args) ?? 'tsconfig.json';

    if (!isDevRunning()) {
        console.log('Building...');
        clean();
        tsc(tsconfig);
        console.log('Build complete.');
    } else {
        console.log('Using existing dev build from another process.');
    }

    const inspectFlag = debug ? '--inspect-brk=9226' : '--inspect=9226';
    const child = spawn(process.execPath, ['--enable-source-maps', inspectFlag, '.', 'migration:run'], {
        stdio: 'inherit',
        cwd: projectDir
    });
    child.on('close', code => process.exit(code ?? 0));
}

function cmdRepl(args: string[]): void {
    const debug = args.includes('--debug');
    const tsconfig = extractTsconfigArg(args) ?? 'tsconfig.json';

    if (!isDevRunning()) {
        console.log('Building...');
        clean();
        tsc(tsconfig);
        console.log('Build complete.');
    } else {
        console.log('Using existing dev build from another process.');
    }

    const inspectFlag = debug ? '--inspect-brk=9227' : '--inspect=9227';
    const child = spawn(process.execPath, ['--enable-source-maps', inspectFlag, '.', 'repl'], {
        stdio: 'inherit',
        cwd: projectDir
    });
    child.on('close', code => process.exit(code ?? 0));
}

function cmdTest(args: string[]): void {
    const debug = args.includes('--debug');
    const tsconfig = extractTsconfigArg(args) ?? 'tsconfig.test.json';
    const testArgs = args.filter(a => a !== '--debug');

    console.log('Building...');
    clean();
    tsc(tsconfig);
    console.log('Build complete.');

    const inspectFlag = debug ? '--inspect-brk=9268' : '--inspect=9268';
    const child = spawn(process.execPath, [inspectFlag, join(__dirname, 'dksf-test.js'), ...testArgs], {
        stdio: 'inherit',
        cwd: projectDir
    });
    child.on('close', code => process.exit(code ?? 0));
}

// --- Entry ---

async function main(): Promise<void> {
    const [cmd, ...args] = process.argv.slice(2);

    switch (cmd) {
        case 'clean':
            cmdClean();
            return;
        case 'build':
            cmdBuild(args);
            return;
        case 'run':
            await cmdRun(args);
            return;
        case 'migrate':
            cmdMigrate(args);
            return;
        case 'repl':
            cmdRepl(args);
            return;
        case 'test':
            cmdTest(args);
            return;
        default:
            console.error(`Usage: dksf-dev <command> [options]

Commands:
  clean                        Remove the dist/ directory
  build [--watch]              Clean and build (--watch for watch mode)
  run [--debug] [script] [--]  Clean, build, and start with node --watch
  migrate [--debug]            Clean, build (if needed), and run migrations
  repl [--debug]               Clean, build (if needed), and start a REPL
  test [--debug] [args...]     Clean, build tests, and run dksf-test

Common options:
  -p, --tsconfig <file>  TypeScript config file (default: tsconfig.json)

Run options:
  --debug      Use --inspect-brk instead of --inspect
  <script>     Entrypoint to run (default: ".", uses package.json "main")
  -- <args>    Arguments passed to the child process (default: server:start)

Environment:
  PORT         When set, inspect port is PORT+1000 (default: 9229)`);
            process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
