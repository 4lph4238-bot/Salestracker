const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { authenticate, adminOnly } = require('../middleware/auth');
const db = require('../db');
require('dotenv').config();

// Limit login attempts to slow down brute-force/credential-stuffing attacks.
// 10 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again in a few minutes.' },
});

// POST /api/auth/register — create a staff account (admin only)
// Always creates a 'user' (staff) account. Admin accounts are never created
// through this endpoint, and an unauthenticated caller can't self-register
// at all — preventing anyone from granting themselves admin access.
router.post('/register', authenticate, adminOnly, async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  }

  try {
    // Check if email already exists
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ message: 'Email already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.query(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [name, email, hashedPassword, 'user']
    );

    res.status(201).json({ message: 'User registered successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      message: 'Login successful.',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/auth/users — Get all staff users (admin only)
router.get('/users', authenticate, adminOnly, async (req, res) => {
  try {
    const [users] = await db.query(
      "SELECT id, name, email, role, created_at FROM users WHERE role = 'user' ORDER BY created_at DESC"
    );
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// DELETE /api/auth/users/:id — Delete a staff account (admin only)
router.delete('/users/:id', authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    // Prevent admin from deleting themselves
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ message: 'You cannot delete your own account.' });
    }
    const [existing] = await db.query('SELECT id, role FROM users WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ message: 'User not found.' });
    if (existing[0].role === 'admin') return res.status(403).json({ message: 'Cannot delete admin accounts.' });

    await db.query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ message: 'Staff account removed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/auth/change-password — Change own password
router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Both current and new password are required.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters.' });
  }
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'User not found.' });

    const isMatch = await bcrypt.compare(currentPassword, rows[0].password);
    if (!isMatch) return res.status(401).json({ message: 'Current password is incorrect.' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);
    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router;
