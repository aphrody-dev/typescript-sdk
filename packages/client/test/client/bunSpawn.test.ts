import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import type { Mock } from 'bun:test';
import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from 'bun:test';

import { getDefaultEnvironment, StdioClientTransport } from '../../src/client/stdio';

type FakeProcess = {
    pid: number;
    stdin: { write: Mock<(data: string) => number>; flush: Mock<() => number>; end: Mock<() => number> };
    stdout: ReadableStream<Uint8Array>;
    stderr: null;
    exited: Promise<number>;
    exitCode: number | null;
    signalCode: string | null;
    kill: Mock<() => void>;
};

function fakeProcess(): FakeProcess {
    return {
        pid: 4242,
        stdin: { write: vi.fn(() => 0), flush: vi.fn(() => 0), end: vi.fn(() => 0) },
        stdout: new ReadableStream<Uint8Array>(),
        stderr: null,
        exited: new Promise<number>(() => {}),
        exitCode: null,
        signalCode: null,
        kill: vi.fn()
    };
}

describe('StdioClientTransport using Bun.spawn', () => {
    let spawn: Mock<typeof Bun.spawn>;
    let proc: FakeProcess;

    beforeEach(() => {
        proc = fakeProcess();
        spawn = spyOn(Bun, 'spawn').mockImplementation((() => (proc = fakeProcess())) as unknown as typeof Bun.spawn) as unknown as Mock<
            typeof Bun.spawn
        >;
    });

    afterEach(() => {
        spawn.mockRestore();
    });

    test('spawns the command with piped stdin/stdout and no shell', async () => {
        const transport = new StdioClientTransport({ command: 'test-command', args: ['arg1', 'arg2'], cwd: '/tmp' });

        await transport.start();

        expect(spawn).toHaveBeenCalledWith(
            ['test-command', 'arg1', 'arg2'],
            expect.objectContaining({ stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', cwd: '/tmp' })
        );
        expect(transport.pid).toBe(4242);
    });

    test('merges custom environment variables over the default environment', async () => {
        const customEnv = { TEST_VAR: 'test-value' };
        const transport = new StdioClientTransport({ command: 'test-command', env: customEnv });

        await transport.start();

        expect(spawn).toHaveBeenCalledWith(
            ['test-command'],
            expect.objectContaining({ env: { ...getDefaultEnvironment(), ...customEnv } })
        );
    });

    test('uses the default environment when env is undefined', async () => {
        const transport = new StdioClientTransport({ command: 'test-command', env: undefined });

        await transport.start();

        expect(spawn).toHaveBeenCalledWith(['test-command'], expect.objectContaining({ env: getDefaultEnvironment() }));
    });

    test('pipes stderr when a stream is requested and maps other values through', async () => {
        await new StdioClientTransport({ command: 'a', stderr: 'pipe' }).start();
        await new StdioClientTransport({ command: 'b', stderr: 'ignore' }).start();
        await new StdioClientTransport({ command: 'c', stderr: 2 }).start();

        expect(spawn.mock.calls.map(([, options]) => (options as { stderr: unknown }).stderr)).toEqual(['pipe', 'ignore', 2]);
    });

    test('writes newline-delimited JSON to stdin and flushes', async () => {
        const transport = new StdioClientTransport({ command: 'test-command' });
        await transport.start();

        const message: JSONRPCMessage = { jsonrpc: '2.0', id: 'test-id', method: 'test-method' };
        await transport.send(message);

        expect(proc.stdin.write).toHaveBeenCalledWith(JSON.stringify(message) + '\n');
        expect(proc.stdin.flush).toHaveBeenCalled();
    });

    test('rejects send before start', async () => {
        const transport = new StdioClientTransport({ command: 'test-command' });
        await expect(transport.send({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow('Not connected');
    });

    test('reports a spawn failure through onerror and start()', async () => {
        spawn.mockImplementation((() => {
            throw new Error('ENOENT: no such file or directory, posix_spawn');
        }) as unknown as typeof Bun.spawn);
        const transport = new StdioClientTransport({ command: 'missing-command' });
        const onerror = vi.fn();
        transport.onerror = onerror;

        await expect(transport.start()).rejects.toThrow('ENOENT');
        expect(onerror).toHaveBeenCalledTimes(1);
    });

    describe('windowsHide', () => {
        const originalPlatform = process.platform;

        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        });

        test.each([
            ['win32', true],
            ['linux', false]
        ] as const)('on %s sets windowsHide to %s', async (platform, expected) => {
            Object.defineProperty(process, 'platform', { value: platform });

            await new StdioClientTransport({ command: 'test-command' }).start();

            expect(spawn).toHaveBeenCalledWith(['test-command'], expect.objectContaining({ windowsHide: expected }));
        });
    });
});
