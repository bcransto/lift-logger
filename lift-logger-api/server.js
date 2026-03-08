const express = require('express');
const path = require('path');
const cors = require('cors');
const syncRouter = require('./routes/sync');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Health check endpoint (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Sync endpoint
app.use('/api/sync', syncRouter);

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Start server
app.listen(PORT, () => {
  console.log(`Lift Logger API running on port ${PORT}`);
});
