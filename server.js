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
// Wake-up route — powers on the Aiven MySQL service via API (server-side to avoid CORS).
// Called by the client-facing wake-up page when the system is down.
app.post('/api/wakeup', async (req, res) => {
  const { pin } = req.body;
  if (pin !== 'starter') {
    return res.status(401).json({ message: 'Invalid access code.' });
  }
  try {
    const response = await fetch(
      'https://api.aiven.io/v1/project/adamsalpha238-dfca/service/mysql-1f04e57c/power_on',
      {
        method: 'POST',
        headers: {
          'Authorization': `aivenv1 ${process.env.AIVEN_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (response.ok || response.status === 409) {
      res.json({ message: 'ok' });
    } else {
      const data = await response.json();
      res.status(500).json({ message: data.message || 'Aiven error' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
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
