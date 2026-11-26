import { describe, expect, it } from 'bun:test';

import type { ServerSentEvent } from '../../src/shared/serverSentEvents';
import { ServerSentEventParser, ServerSentEventStream } from '../../src/shared/serverSentEvents';

function parse(chunks: string[]): { events: ServerSentEvent[]; retries: number[] } {
    const events: ServerSentEvent[] = [];
    const retries: number[] = [];
    const parser = new ServerSentEventParser(e => events.push(e), { onRetry: ms => retries.push(ms) });
    for (const chunk of chunks) parser.feed(chunk);
    return { events, retries };
}

describe('ServerSentEventParser', () => {
    it('dispatches events with id, event and multi-line data', () => {
        const { events } = parse(['id: 7\nevent: message\ndata: a\ndata: b\n\n']);
        expect(events).toEqual([{ id: '7', event: 'message', data: 'a\nb' }]);
    });

    it('dispatches an id-only priming event with empty data but skips data-less blocks', () => {
        const { events } = parse(['id: 1\ndata:\n\n', 'id: 2\n\n', ': keep-alive\n\n']);
        expect(events).toEqual([{ id: '1', event: undefined, data: '' }]);
    });

    it('handles CR, LF and CRLF line endings split across chunks', () => {
        const { events } = parse(['data: x\r', '\n\r', '\ndata: y\r\rdata: z\n', '\n']);
        expect(events.map(e => e.data)).toEqual(['x', 'y', 'z']);
    });

    it('reports numeric retry values only', () => {
        const { retries } = parse(['retry: 1500\nretry: soon\n\n']);
        expect(retries).toEqual([1500]);
    });

    it('drops an unterminated trailing event and a leading BOM', () => {
        const { events } = parse(['﻿data: ok\n\ndata: partial']);
        expect(events).toEqual([{ id: undefined, event: undefined, data: 'ok' }]);
    });

    it('works as a TransformStream', async () => {
        const body = new Response('data: {"a":1}\n\nevent: endpoint\ndata: /post\n\n').body!;
        const events = await Array.fromAsync(body.pipeThrough(new TextDecoderStream()).pipeThrough(new ServerSentEventStream()));
        expect(events).toEqual([
            { id: undefined, event: undefined, data: '{"a":1}' },
            { id: undefined, event: 'endpoint', data: '/post' }
        ]);
    });
});
