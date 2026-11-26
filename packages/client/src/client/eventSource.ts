import type { FetchLike } from '@modelcontextprotocol/core-internal';
import { ServerSentEventParser } from '@modelcontextprotocol/core-internal';

/** Options for the SSE connection (the `eventsource` package's `EventSourceInit` shape). */
export interface EventSourceInit {
    /** `fetch` used to open (and re-open) the event stream. */
    fetch?: FetchLike;
    /** Whether credentials are sent with the request (only meaningful in browsers). */
    withCredentials?: boolean;
}

/** `error` event fired by the SSE connection: `code` is the HTTP status when there is one. */
export class ErrorEvent extends Event {
    readonly code?: number;
    readonly message?: string;

    constructor(type: string, init?: { code?: number; message?: string }) {
        super(type);
        this.code = init?.code;
        this.message = init?.message;
    }
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

function flattenError(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    if ('errors' in error && Array.isArray(error.errors)) return error.errors.map(e => flattenError(e)).join(', ');
    if (error.cause instanceof Error) return `${error}: ${flattenError(error.cause)}`;
    return error.message;
}

/**
 * Minimal WHATWG `EventSource` over `fetch` streaming: reconnects after a dropped stream or
 * network error (honouring `retry:`, sending `Last-Event-ID`), and fails without reconnecting
 * on a non-200 status or a non-`text/event-stream` response.
 *
 * @internal
 */
export class EventSource extends EventTarget {
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;

    private _readyState = CONNECTING;
    private _reconnectInterval = 3000;
    private _reconnectTimer?: ReturnType<typeof setTimeout>;
    private _lastEventId: string | undefined;
    private _controller?: AbortController;
    private _redirectUrl?: URL;
    private readonly _fetch: FetchLike;
    private readonly _withCredentials: boolean;
    private readonly _parser = new ServerSentEventParser(
        event => {
            if (event.id !== undefined) this._lastEventId = event.id;
            const message = new MessageEvent(event.event || 'message', {
                data: event.data,
                origin: (this._redirectUrl ?? this.url).origin,
                lastEventId: event.id || ''
            });
            if (!event.event || event.event === 'message') this.onmessage?.(message);
            this.dispatchEvent(message);
        },
        { onRetry: ms => (this._reconnectInterval = ms) }
    );

    constructor(
        readonly url: URL,
        init?: EventSourceInit
    ) {
        super();
        this._fetch = init?.fetch ?? fetch;
        this._withCredentials = init?.withCredentials ?? false;
        this._connect();
    }

    get readyState(): number {
        return this._readyState;
    }

    close(): void {
        clearTimeout(this._reconnectTimer);
        if (this._readyState === CLOSED) return;
        this._controller?.abort();
        this._controller = undefined;
        this._readyState = CLOSED;
    }

    private _connect(): void {
        this._readyState = CONNECTING;
        this._controller = new AbortController();
        const init: RequestInit = {
            mode: 'cors',
            redirect: 'follow',
            headers: { Accept: 'text/event-stream', ...(this._lastEventId ? { 'Last-Event-ID': this._lastEventId } : undefined) },
            cache: 'no-store',
            signal: this._controller.signal
        };
        if ('window' in globalThis) init.credentials = this._withCredentials ? 'include' : 'same-origin';
        this._fetch(this.url, init)
            .then(response => this._onResponse(response))
            .catch((error: unknown) => {
                this._controller = undefined;
                const name = (error as { name?: string })?.name;
                if (name !== 'AbortError' && (error as { type?: string })?.type !== 'aborted') {
                    this._scheduleReconnect(flattenError(error));
                }
            });
    }

    private async _onResponse(response: Response): Promise<void> {
        this._parser.reset();
        const { body, status, headers } = response;
        if (status === 204) {
            this._fail('Server sent HTTP 204, not reconnecting', 204);
            this.close();
            return;
        }
        this._redirectUrl = response.redirected ? new URL(response.url) : undefined;
        if (status !== 200) {
            this._fail(`Non-200 status code (${status})`, status);
            return;
        }
        if (!(headers.get('content-type') || '').startsWith('text/event-stream')) {
            this._fail('Invalid content type, expected "text/event-stream"', status);
            return;
        }
        if (this._readyState === CLOSED) return;
        this._readyState = OPEN;
        const openEvent = new Event('open');
        this.onopen?.(openEvent);
        this.dispatchEvent(openEvent);
        if (!body) {
            this._fail('Invalid response body, expected a web ReadableStream', status);
            this.close();
            return;
        }
        const decoder = new TextDecoder();
        const reader = body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (value) this._parser.feed(decoder.decode(value, { stream: !done }));
            if (done) break;
        }
        this._parser.reset();
        this._scheduleReconnect();
    }

    private _fail(message: string, code: number): void {
        this._readyState = CLOSED;
        this._emitError(new ErrorEvent('error', { code, message }));
    }

    private _scheduleReconnect(message?: string): void {
        if (this._readyState === CLOSED) return;
        this._readyState = CONNECTING;
        this._emitError(new ErrorEvent('error', { message }));
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = undefined;
            if (this._readyState === CONNECTING) this._connect();
        }, this._reconnectInterval);
    }

    private _emitError(event: ErrorEvent): void {
        this.onerror?.(event);
        this.dispatchEvent(event);
    }
}
