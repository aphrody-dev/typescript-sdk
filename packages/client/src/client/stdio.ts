import type { IOType } from 'node:child_process';
import process from 'node:process';
import type { Stream, Writable } from 'node:stream';
import { PassThrough } from 'node:stream';

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import { ReadBuffer, SdkError, SdkErrorCode, serializeMessage } from '@modelcontextprotocol/core-internal';
import type { FileSink, Subprocess } from 'bun';

type PipeReader = { read(): Promise<{ done: true; value?: unknown } | { done: false; value: Uint8Array }>; cancel(): Promise<void> };

export type StdioServerParameters = {
    /**
     * The executable to run to start the server.
     */
    command: string;

    /**
     * Command line arguments to pass to the executable.
     */
    args?: string[];

    /**
     * The environment to use when spawning the process.
     *
     * If not specified, the result of {@linkcode getDefaultEnvironment} will be used.
     */
    env?: Record<string, string>;

    /**
     * How to handle stderr of the child process, as with Node's `child_process.spawn`: `"inherit"`, `"ignore"`, a file descriptor, `"pipe"`/`"overlapped"` (read it from {@linkcode StdioClientTransport.stderr}), or a writable Node stream that receives the output.
     *
     * The default is `"inherit"`, meaning messages to stderr will be printed to the parent process's stderr.
     */
    stderr?: IOType | Stream | number;

    /**
     * The working directory to use when spawning the process.
     *
     * If not specified, the current working directory will be inherited.
     */
    cwd?: string;

    /**
     * Maximum size of the read buffer in bytes. If a single message exceeds
     * this size the transport will emit an error and close.
     *
     * Defaults to 10 MB.
     */
    maxBufferSize?: number;
};

/**
 * Environment variables to inherit by default, if an environment is not explicitly given.
 */
export const DEFAULT_INHERITED_ENV_VARS =
    process.platform === 'win32'
        ? [
              'APPDATA',
              'COMSPEC',
              'HOMEDRIVE',
              'HOMEPATH',
              'LOCALAPPDATA',
              'PATH',
              'PATHEXT',
              'PROCESSOR_ARCHITECTURE',
              'PROGRAMDATA',
              'PROGRAMFILES',
              'PROGRAMFILES(X86)',
              'PROGRAMW6432',
              'SYSTEMDRIVE',
              'SYSTEMROOT',
              'TEMP',
              'USERNAME',
              'USERPROFILE',
              'WINDIR'
          ]
        : /* list inspired by the default env inheritance of sudo */
          ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

/**
 * Returns a default environment object including only environment variables deemed safe to inherit.
 */
export function getDefaultEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};

    for (const key of DEFAULT_INHERITED_ENV_VARS) {
        const value = process.env[key];
        if (value === undefined) {
            continue;
        }

        if (value.startsWith('()')) {
            // Skip functions, which are a security risk.
            continue;
        }

        env[key] = value;
    }

    return env;
}

/**
 * Client transport for stdio: this will connect to a server by spawning a process and communicating with it over stdin/stdout.
 *
 * The process is spawned with `Bun.spawn`, so this transport requires the Bun runtime.
 */
export class StdioClientTransport implements Transport {
    private _process?: Subprocess<'pipe', 'pipe', Bun.Spawn.Readable>;
    private _closed?: Promise<void>;
    private _stdoutReader?: PipeReader;
    private _stderrReader?: PipeReader;
    private _readBuffer: ReadBuffer;
    private _serverParams: StdioServerParameters;
    private _stderrStream: PassThrough | null = null;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(server: StdioServerParameters) {
        this._serverParams = server;
        this._readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize });
        if (server.stderr === 'pipe' || server.stderr === 'overlapped') {
            this._stderrStream = new PassThrough();
        }
    }

    /**
     * Starts the server process and prepares to communicate with it.
     */
    async start(): Promise<void> {
        if (this._process) {
            throw new Error(
                'StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.'
            );
        }

        const stderr = this._serverParams.stderr ?? 'inherit';
        // A Node stream (or 'pipe'/'overlapped') is fed from a piped stderr; the rest map onto Bun's stdio options.
        const stderrTarget: Writable | null = this._stderrStream ?? (typeof stderr === 'object' ? (stderr as Writable) : null);
        let proc: Subprocess<'pipe', 'pipe', Bun.Spawn.Readable>;
        try {
            proc = Bun.spawn([this._serverParams.command, ...(this._serverParams.args ?? [])], {
                // merge default env with server env because mcp server needs some env vars
                env: {
                    ...getDefaultEnvironment(),
                    ...this._serverParams.env
                },
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: stderrTarget ? 'pipe' : (stderr as 'inherit' | 'ignore' | number),
                windowsHide: process.platform === 'win32',
                cwd: this._serverParams.cwd
            });
        } catch (error) {
            this.onerror?.(error as Error);
            throw error;
        }
        this._process = proc;

        const stdoutDone = this._readStdout(proc.stdout.getReader());
        let stderrDone: Promise<void> = Promise.resolve();
        if (stderrTarget && proc.stderr instanceof ReadableStream) {
            const reader: PipeReader = proc.stderr.getReader();
            this._stderrReader = reader;
            stderrDone = pump(reader, stderrTarget, stderrTarget === this._stderrStream);
        }
        // Node's 'close' semantics: the process has exited and its stdio pipes are drained.
        this._closed = Promise.all([proc.exited, stdoutDone, stderrDone]).then(() => {
            if (this._process === proc) this._process = undefined;
            this.onclose?.();
        });
    }

    private async _readStdout(reader: PipeReader): Promise<void> {
        this._stdoutReader = reader;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                try {
                    this._readBuffer.append(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
                    this.processReadBuffer();
                } catch (error) {
                    this.onerror?.(error as Error);
                    this.close().catch(() => {});
                }
            }
        } catch (error) {
            if (this._stdoutReader === reader) this.onerror?.(error as Error);
        }
    }

    /**
     * The `stderr` stream of the child process, if {@linkcode StdioServerParameters.stderr} was set to `"pipe"` or `"overlapped"`.
     *
     * If `stderr` piping was requested, a `PassThrough` stream is returned _immediately_, allowing callers to
     * attach listeners before the `start` method is invoked. This prevents loss of any early
     * error output emitted by the child process.
     */
    get stderr(): Stream | null {
        return this._stderrStream;
    }

    /**
     * The child process pid spawned by this transport.
     *
     * This is only available after the transport has been started.
     */
    get pid(): number | null {
        return this._process?.pid ?? null;
    }

    private processReadBuffer() {
        while (true) {
            try {
                const message = this._readBuffer.readMessage();
                if (message === null) {
                    break;
                }

                this.onmessage?.(message);
            } catch (error) {
                this.onerror?.(error as Error);
            }
        }
    }

    /** Cancels the parent-side pipe readers so a helper process holding the child's stdio cannot pin the event loop. */
    private _releasePipes(): void {
        const stdout = this._stdoutReader;
        const stderr = this._stderrReader;
        this._stdoutReader = undefined;
        this._stderrReader = undefined;
        stdout?.cancel().catch(() => {});
        stderr?.cancel().catch(() => {});
    }

    /**
     * Reap a disposable probe sibling (see the version-negotiation sibling
     * flow): signal-first teardown awaiting process exit — never the drained
     * pipes, so a helper process holding the child's stdio pipes can never
     * block disposal. Not part of the public transport lifecycle.
     *
     * @internal
     */
    private async _dispose(): Promise<void> {
        const proc = this._process;
        this._process = undefined;
        if (proc && proc.exitCode === null && proc.signalCode === null) {
            endQuietly(proc.stdin);
            killQuietly(proc, 'SIGTERM');
            await Promise.race([proc.exited, delay(1000)]);
            if (proc.exitCode === null && proc.signalCode === null) {
                killQuietly(proc, 'SIGKILL');
            }
            await proc.exited;
        }
        this._releasePipes();
        this._readBuffer.clear();
    }

    async close(): Promise<void> {
        const proc = this._process;
        if (proc) {
            this._process = undefined;
            const closed = this._closed ?? proc.exited;

            endQuietly(proc.stdin);
            await Promise.race([closed, delay(2000)]);

            if (proc.exitCode === null && proc.signalCode === null) {
                killQuietly(proc, 'SIGTERM');
                await Promise.race([closed, delay(2000)]);
            }

            if (proc.exitCode === null && proc.signalCode === null) {
                killQuietly(proc, 'SIGKILL');
            }
        }

        this._readBuffer.clear();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        const stdin = this._process?.stdin;
        if (!stdin) {
            throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        }
        try {
            await stdin.write(serializeMessage(message));
            await stdin.flush();
        } catch (error) {
            this.onerror?.(error as Error);
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms).unref());
}

function endQuietly(stdin: FileSink): void {
    try {
        const ended = stdin.end();
        if (ended instanceof Promise) ended.catch(() => {});
    } catch {
        // ignore
    }
}

function killQuietly(proc: Subprocess, signal: NodeJS.Signals): void {
    try {
        proc.kill(signal);
    } catch {
        // ignore
    }
}

/** Copies `reader` into the Node stream `target`, ending it at EOF when `end` is set (as `stream.pipe` does). */
async function pump(reader: PipeReader, target: Writable, end: boolean): Promise<void> {
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            target.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
    } catch {
        // cancelled by _dispose
    }
    if (end) target.end();
}
