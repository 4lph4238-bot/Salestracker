const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate, adminOnly } = require('../middleware/auth');

// GET /api/loans — list loan sales (admin only)
// Optional ?status=pending|partially_paid|fully_paid filter
router.get('/', authenticate, adminOnly, async (req, res) => {
  try {
    let where = '';
    const params = [];
    if (req.query.status) {
      where = 'WHERE l.status = ?';
      params.push(req.query.status);
    }

    const [loans] = await db.query(
      `SELECT l.id, l.sale_id, l.customer_name, l.date_loaned, l.amount_paid,
              l.amount_to_be_paid, (l.amount_to_be_paid - l.amount_paid) AS balance_due,
              l.date_to_be_paid, l.status,
              s.quantity_sold, s.total_revenue, s.is_settled,
              COALESCE(p.name, 'Deleted Product') AS product,
              u.name AS sold_by
       FROM loans l
       JOIN sales s ON l.sale_id = s.id
       LEFT JOIN products p ON s.product_id = p.id
       JOIN users u ON s.user_id = u.id
       ${where}
       ORDER BY l.date_to_be_paid ASC`,
      params
    );

    res.json({ loans });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/loans/alerts — loans due tomorrow that aren't fully paid yet (admin only)
// Intended for the admin dashboard to surface "pay date is tomorrow" reminders.
router.get('/alerts', authenticate, adminOnly, async (req, res) => {
  try {
    const [loans] = await db.query(
      `SELECT l.id, l.sale_id, l.customer_name, l.amount_paid, l.amount_to_be_paid,
              (l.amount_to_be_paid - l.amount_paid) AS balance_due,
              l.date_to_be_paid, l.status,
              COALESCE(p.name, 'Deleted Product') AS product
       FROM loans l
       JOIN sales s ON l.sale_id = s.id
       LEFT JOIN products p ON s.product_id = p.id
       WHERE l.status != 'fully_paid'
         AND l.date_to_be_paid = DATE_ADD(CURDATE(), INTERVAL 1 DAY)
       ORDER BY l.customer_name ASC`
    );

    res.json({
      count: loans.length,
      loans,
      message: loans.length > 0
        ? `⏰ ${loans.length} loan repayment(s) due tomorrow.`
        : 'No loan repayments due tomorrow.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/loans/:id/repay — record a repayment against a loan
// Body: { amount: number }
// If the loan becomes fully paid, the linked sale is marked as settled so
// its revenue/profit/margin start counting in reports.
router.post('/:id/repay', authenticate, async (req, res) => {
  const { id } = req.params;
  const amount = parseFloat(req.body.amount);

  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ message: 'A positive repayment amount is required.' });
  }

  try {
    const [loans] = await db.query('SELECT * FROM loans WHERE id = ?', [id]);
    if (loans.length === 0) {
      return res.status(404).json({ message: 'Loan not found.' });
    }

    const loan = loans[0];
    const newAmountPaid = Math.min(loan.amount_paid + amount, loan.amount_to_be_paid);
    const fullyPaid = newAmountPaid >= loan.amount_to_be_paid;
    const newStatus = fullyPaid ? 'fully_paid' : 'partially_paid';

    await db.query('UPDATE loans SET amount_paid = ?, status = ? WHERE id = ?', [newAmountPaid, newStatus, id]);

    if (fullyPaid) {
      await db.query('UPDATE sales SET is_settled = 1 WHERE id = ?', [loan.sale_id]);
    }

    res.json({
      message: fullyPaid ? 'Loan fully repaid. Sale now counts in reports.' : 'Repayment recorded.',
      amount_paid: newAmountPaid,
      balance_due: parseFloat((loan.amount_to_be_paid - newAmountPaid).toFixed(2)),
      status: newStatus,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router;
