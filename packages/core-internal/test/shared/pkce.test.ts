import { describe, expect, it } from 'bun:test';

import { generatePkceChallenge, pkceChallenge, verifyPkceChallenge } from '../../src/shared/pkce';

describe('PKCE S256', () => {
    it('matches the RFC 7636 appendix B vector', async () => {
        expect(await generatePkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
            'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
        );
    });

    it('generates unreserved verifiers whose challenge verifies', async () => {
        for (const length of [43, 64, 128]) {
            const { code_verifier, code_challenge } = await pkceChallenge(length);
            expect(code_verifier).toMatch(new RegExp(`^[A-Za-z0-9._~-]{${length}}$`));
            expect(await verifyPkceChallenge(code_verifier, code_challenge)).toBe(true);
            expect(await verifyPkceChallenge(`${code_verifier}x`, code_challenge)).toBe(false);
        }
    });

    it('rejects lengths outside 43..128', async () => {
        await expect(pkceChallenge(42)).rejects.toThrow(RangeError);
        await expect(pkceChallenge(129)).rejects.toThrow(RangeError);
    });
});
