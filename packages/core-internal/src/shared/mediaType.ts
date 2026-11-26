// RFC 9110 media-type grammar (token "/" token *( OWS ";" OWS parameter )), as in the `content-type` package.
const TYPE_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PARAM_REGEXP =
    /; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000B\u0020\u0021\u0023-\u005B\u005D-\u007E\u0080-\u00FF]|\\[\u000B\u0020-\u00FF])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) */g;
const QUOTED_PAIR_REGEXP = /\\([\u000B\u0020-\u00FF])/g;

/** A parsed `Content-Type` value: the lowercased media type and its lowercased-name parameters. */
export interface ParsedContentType {
    type: string;
    parameters: Record<string, string>;
}

/**
 * Strictly parses a `Content-Type` header value per RFC 9110. Throws `TypeError` on any
 * malformed type or parameter section.
 */
export function parseContentType(header: string): ParsedContentType {
    let index = header.indexOf(';');
    const type = (index === -1 ? header : header.slice(0, index)).trim();
    if (!TYPE_REGEXP.test(type)) {
        throw new TypeError('invalid media type');
    }
    const parameters: Record<string, string> = Object.create(null);
    if (index !== -1) {
        PARAM_REGEXP.lastIndex = index;
        let match: RegExpExecArray | null;
        while ((match = PARAM_REGEXP.exec(header))) {
            if (match.index !== index) {
                throw new TypeError('invalid parameter format');
            }
            index += match[0].length;
            let value = match[2]!;
            if (value.charCodeAt(0) === 0x22) {
                value = value.slice(1, -1);
                if (value.includes('\\')) value = value.replace(QUOTED_PAIR_REGEXP, '$1');
            }
            parameters[match[1]!.toLowerCase()] = value;
        }
        if (index !== header.length) {
            throw new TypeError('invalid parameter format');
        }
    }
    return { type: type.toLowerCase(), parameters };
}

/**
 * Extracts the media type (the lowercased `type/subtype` pair, without
 * parameters) from a raw `Content-Type` header value, or `undefined` when the
 * header is missing or empty.
 *
 * Content-Type comparisons must use the parsed media type, never a substring
 * search of the raw header: a value like `text/plain; a=application/json`
 * contains the substring `application/json` but its media type is
 * `text/plain`, and case variants or parameters make naive string comparison
 * wrong in both directions.
 *
 * "Essence" is the WHATWG MIME Sniffing standard's term for the bare
 * `type/subtype` pair (https://mimesniff.spec.whatwg.org/#mime-type-essence);
 * the Fetch standard's request classification is defined against it
 * (https://fetch.spec.whatwg.org/#cors-safelisted-request-header).
 *
 * Parsing is RFC 9110 ({@link parseContentType}) first. When the parameter
 * section is malformed (`application/json;`, `application/json; charset=`),
 * browsers and most HTTP stacks still derive the media type from the segment
 * before the first `;` — the fallback matches that widely-implemented
 * behavior, so a header whose media type is unambiguous is not rejected for
 * a sloppy parameter section.
 */
export function mediaTypeEssence(header: string | null | undefined): string | undefined {
    if (!header) {
        return undefined;
    }
    try {
        return parseContentType(header).type;
    } catch {
        const essence = (header.split(';', 1)[0] ?? '').trim().toLowerCase();
        // A comma in the parameter tail of an unparseable value indicates
        // joined duplicate headers — ambiguous, so no essence at all (keeps
        // duplicate-header handling uniform whether or not the first copy
        // carries parameters).
        if (essence === '' || header.slice(essence.length).includes(',')) {
            return undefined;
        }
        return essence;
    }
}

/**
 * Whether a raw `Content-Type` header value denotes `application/json`.
 * Parameters (for example `charset=utf-8`) are allowed and ignored; malformed
 * parameter sections do not reject a header whose media type is unambiguously
 * `application/json` (see `mediaTypeEssence` for the exact grammar).
 */
export function isJsonContentType(header: string | null | undefined): boolean {
    // Fast path: the exact literal is what SDK clients send on every POST.
    if (header === 'application/json') {
        return true;
    }
    return mediaTypeEssence(header) === 'application/json';
}
