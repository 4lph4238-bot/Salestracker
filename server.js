const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./db');
const app = express();
// Middleware
app.use(cors());
app.use(express.json());
// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/loans', require('./routes/loans'));
// Health check (server only)
app.get('/', (req, res) => {
  res.json({ message: 'Sales & Inventory Tracker API is running.' });
});
// Health check that also touches the database — point an uptime pinger
// (UptimeRobot, cron-job.org, etc.) at this URL every 10 minutes to keep
// both Render and the Aiven database from going to sleep on the free tier.
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', db: 'unreachable' });
  }
});
// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});
// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong.' });
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
