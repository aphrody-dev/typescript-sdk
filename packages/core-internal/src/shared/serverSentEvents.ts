/** One dispatched server-sent event. `id` and `event` are those set within this event only. */
export interface ServerSentEvent {
    id?: string;
    event?: string;
    data: string;
}

export interface ServerSentEventStreamOptions {
    /** Called with each valid `retry:` field value (milliseconds). */
    onRetry?: (retryMs: number) => void;
}

/**
 * Incremental parser for the WHATWG `text/event-stream` format. Feed decoded text with
 * {@linkcode ServerSentEventParser.feed}; each complete event (one with at least one `data:`
 * line) is passed to `onEvent`.
 */
export class ServerSentEventParser {
    private _pending = '';
    private _first = true;
    private _id: string | undefined;
    private _event: string | undefined;
    private _data = '';
    private _dataLines = 0;

    constructor(
        private readonly _onEvent: (event: ServerSentEvent) => void,
        private readonly _options: ServerSentEventStreamOptions = {}
    ) {}

    feed(chunk: string): void {
        if (this._first) {
            this._first = false;
            if (chunk.charCodeAt(0) === 0xfe_ff) chunk = chunk.slice(1);
        }
        const text = this._pending === '' ? chunk : this._pending + chunk;
        let start = 0;
        const length = text.length;
        while (start < length) {
            let end = text.indexOf('\n', start);
            const cr = text.indexOf('\r', start);
            if (cr !== -1 && (end === -1 || cr < end)) {
                // A trailing CR may be the first half of CRLF: wait for more input.
                if (cr === length - 1) break;
                end = cr;
            }
            if (end === -1) break;
            this._line(text, start, end);
            start = text.charCodeAt(end) === 0x0d && text.charCodeAt(end + 1) === 0x0a ? end + 2 : end + 1;
        }
        this._pending = start === 0 ? text : text.slice(start);
    }

    /** Discards any partial line and event (an unterminated event is never dispatched). */
    reset(): void {
        this._pending = '';
        this._first = true;
        this._clear();
    }

    private _clear(): void {
        this._id = undefined;
        this._event = undefined;
        this._data = '';
        this._dataLines = 0;
    }

    private _line(text: string, start: number, end: number): void {
        if (start === end) {
            if (this._dataLines > 0) this._onEvent({ id: this._id, event: this._event, data: this._data });
            this._clear();
            return;
        }
        if (text.charCodeAt(start) === 0x3a) return;
        const colon = text.indexOf(':', start);
        let field: string;
        let value: string;
        if (colon === -1 || colon > end) {
            field = text.slice(start, end);
            value = '';
        } else {
            field = text.slice(start, colon);
            const valueStart = text.charCodeAt(colon + 1) === 0x20 ? colon + 2 : colon + 1;
            value = valueStart > end ? '' : text.slice(valueStart, end);
        }
        switch (field) {
            case 'data': {
                this._data = this._dataLines++ === 0 ? value : `${this._data}\n${value}`;
                break;
            }
            case 'event': {
                this._event = value || undefined;
                break;
            }
            case 'id': {
                this._id = value.includes('\0') ? undefined : value;
                break;
            }
            case 'retry': {
                if (/^\d+$/.test(value)) this._options.onRetry?.(Number.parseInt(value, 10));
                break;
            }
        }
    }
}

/** `TransformStream` from decoded `text/event-stream` text to {@linkcode ServerSentEvent}s. */
export class ServerSentEventStream extends TransformStream<string, ServerSentEvent> {
    constructor(options?: ServerSentEventStreamOptions) {
        let parser!: ServerSentEventParser;
        super({
            start(controller) {
                parser = new ServerSentEventParser(event => controller.enqueue(event), options);
            },
            transform(chunk) {
                parser.feed(chunk);
            }
        });
    }
}
