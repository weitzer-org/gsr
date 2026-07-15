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

// Wraps fetch() so a 401 (no/expired login session) redirects to the login
// page instead of surfacing as a confusing failed API call.
export async function authFetch(url, options) {
    const response = await fetch(url, options);
    if (response.status === 401) {
        window.location.href = '/login';
        throw new Error('Unauthorized — redirecting to login.');
    }
    return response;
}

export function wireLogoutLink(elementId = 'logout-link') {
    const link = document.getElementById(elementId);
    if (!link) return;
    link.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            await fetch('/logout', { method: 'POST' });
        } finally {
            window.location.href = '/login';
        }
    });
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
