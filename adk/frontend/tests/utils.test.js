import { escapeHTML, parseStreamChunk } from '../utils.js';
import { TextDecoder, TextEncoder } from 'util';

// Polyfill for jsdom which might lack these globals
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = TextDecoder;
}
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
}


describe('utils.js', () => {
  describe('escapeHTML', () => {
    it('should escape special characters', () => {
      expect(escapeHTML('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(escapeHTML("John's")).toBe('John&#39;s');
      expect(escapeHTML('A & B')).toBe('A &amp; B');
    });

    it('should return empty string for empty input', () => {
      expect(escapeHTML('')).toBe('');
      expect(escapeHTML(null)).toBe('');
    });
  });

  describe('parseStreamChunk', () => {
    let decoder;

    beforeEach(() => {
      decoder = new TextDecoder('utf-8');
    });

    it('should parse complete lines', () => {
      const chunk = new TextEncoder().encode('line1\nline2\n');
      const result = parseStreamChunk(chunk, decoder, '');
      expect(result.lines).toEqual(['line1', 'line2']);
      expect(result.buffer).toBe('');
    });

    it('should retain partial line in buffer', () => {
      const chunk = new TextEncoder().encode('line1\nline2');
      const result = parseStreamChunk(chunk, decoder, '');
      expect(result.lines).toEqual(['line1']);
      expect(result.buffer).toBe('line2');
    });

    it('should prepend existing buffer', () => {
      const chunk = new TextEncoder().encode('line2\n');
      const result = parseStreamChunk(chunk, decoder, 'line1');
      expect(result.lines).toEqual(['line1line2']);
      expect(result.buffer).toBe('');
    });
  });
});
