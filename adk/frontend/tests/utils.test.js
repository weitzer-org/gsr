import { jest } from '@jest/globals';
import { escapeHTML, parseStreamChunk, renderMarkdownSafely } from '../utils.js';
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

    it('should coerce non-string values instead of throwing', () => {
      expect(escapeHTML(42)).toBe('42');
      expect(escapeHTML(0)).toBe('0');
      expect(escapeHTML(undefined)).toBe('');
    });
  });

  describe('renderMarkdownSafely', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    let savedMarked;
    let savedPurify;
    beforeEach(() => { savedMarked = global.marked; savedPurify = window.DOMPurify; });
    afterEach(() => { global.marked = savedMarked; window.DOMPurify = savedPurify; });

    it('parses then sanitizes when both marked and DOMPurify are loaded', () => {
      global.marked = { parse: jest.fn((t) => `<p>${t}</p>`) };
      window.DOMPurify = { sanitize: jest.fn((h) => `clean:${h}`) };
      expect(renderMarkdownSafely('hi')).toBe('clean:<p>hi</p>');
      expect(global.marked.parse).toHaveBeenCalledWith('hi');
    });

    it('fails closed (escaped text, no parsing) when DOMPurify did not load', () => {
      global.marked = { parse: jest.fn() };
      delete window.DOMPurify;
      expect(renderMarkdownSafely(`a\n${hostile}`)).toBe('a<br/>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
      expect(global.marked.parse).not.toHaveBeenCalled();
    });

    it('fails closed when marked did not load, even if DOMPurify did', () => {
      delete global.marked;
      window.DOMPurify = { sanitize: jest.fn() };
      expect(renderMarkdownSafely(hostile)).not.toContain('<img');
      expect(window.DOMPurify.sanitize).not.toHaveBeenCalled();
    });

    it('treats null and undefined as empty', () => {
      delete window.DOMPurify;
      expect(renderMarkdownSafely(null)).toBe('');
      expect(renderMarkdownSafely(undefined)).toBe('');
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
