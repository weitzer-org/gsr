export function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag])
    );
}

export function parseStreamChunk(chunkValue, decoder, buffer = '') {
    const text = decoder.decode(chunkValue, { stream: true });
    const combined = buffer + text;
    const lines = combined.split('\n');
    const partial = lines.pop();
    return { 
        lines: lines.filter(l => l.trim()), 
        buffer: partial 
    };
}
