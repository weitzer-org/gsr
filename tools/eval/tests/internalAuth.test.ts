import { isValidInternalKey } from '../internalAuth';

describe('isValidInternalKey', () => {
    it('allows any request when no secret is configured', () => {
        expect(isValidInternalKey(undefined, undefined)).toBe(true);
        expect(isValidInternalKey('anything', undefined)).toBe(true);
    });

    it('accepts a matching key', () => {
        expect(isValidInternalKey('shared-secret', 'shared-secret')).toBe(true);
    });

    it('rejects a mismatched key', () => {
        expect(isValidInternalKey('wrong', 'shared-secret')).toBe(false);
    });

    it('rejects a missing key when a secret is configured', () => {
        expect(isValidInternalKey(undefined, 'shared-secret')).toBe(false);
    });
});
