// RFC 7636 PKCE with the S256 method, on WebCrypto (Bun, Node, Deno, browsers, workerd).

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function base64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** `BASE64URL(SHA256(ASCII(code_verifier)))`, the S256 `code_challenge` for `codeVerifier`. */
export async function generatePkceChallenge(codeVerifier: string): Promise<string> {
    return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))));
}

/** A random `code_verifier` of `length` unreserved characters (43–128) and its S256 `code_challenge`. */
export async function pkceChallenge(length = 43): Promise<{ code_verifier: string; code_challenge: string }> {
    if (length < 43 || length > 128) {
        throw new RangeError(`Expected a length between 43 and 128. Received ${length}.`);
    }
    // 66 symbols: reject bytes >= 198 (3 * 66) so every symbol is equally likely.
    let verifier = '';
    while (verifier.length < length) {
        for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
            if (byte < 198 && verifier.length < length) verifier += UNRESERVED[byte % 66];
        }
    }
    return { code_verifier: verifier, code_challenge: await generatePkceChallenge(verifier) };
}

/** Whether `codeVerifier` hashes (S256) to `expectedChallenge`. */
export async function verifyPkceChallenge(codeVerifier: string, expectedChallenge: string): Promise<boolean> {
    return (await generatePkceChallenge(codeVerifier)) === expectedChallenge;
}
