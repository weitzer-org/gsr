const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Log all requests to the terminal
app.use((req, res, next) => {
    console.log(`[Frontend] ${req.method} ${req.url}`);
    next();
});

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

// Fallback to index.html for single-page app behavior
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`GSR ADK Frontend server running at http://localhost:${PORT}`);
});
