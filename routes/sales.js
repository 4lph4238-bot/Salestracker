const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate } = require('../middleware/auth');

// How much of a loan must be paid on the date of purchase for the sale's
// revenue/profit to count immediately in reports (0-1). Configurable via .env.
const LOAN_SETTLEMENT_THRESHOLD = parseFloat(process.env.LOAN_SETTLEMENT_THRESHOLD || '0.5');

// POST /api/sales — Record a sale (both admin and user)
// Supports two payment types:
//   - payment_type = 'cash' (default): works exactly as before.
//   - payment_type = 'loan': the customer takes goods now and pays later.
//     Requires customer_name, date_loaned, amount_paid (>= 0), amount_to_be_paid,
//     date_to_be_paid. Stock is deducted immediately either way, but the
//     sale's revenue/profit/profit-margin only counts in reports once the
//     loan is fully repaid, or if the amount paid on the date of purchase
//     meets the configured settlement threshold.
router.post('/', authenticate, async (req, res) => {
  const {
    product_id, quantity_sold, sale_price, discount,
    payment_type, customer_name, date_loaned, amount_paid, amount_to_be_paid, date_to_be_paid,
  } = req.body;

  const qty = parseFloat(quantity_sold);
  const isLoan = payment_type === 'loan';

  if (!product_id || !qty || qty <= 0) {
    return res.status(400).json({ message: 'Product ID and a valid quantity are required.' });
  }

  // Validate loan-specific fields up front
  let loanAmountPaid = 0;
  let loanAmountToBePaid = 0;
  if (isLoan) {
    if (!customer_name || !customer_name.trim()) {
      return res.status(400).json({ message: 'Customer name is required for a loan sale.' });
    }
    if (!date_loaned) {
      return res.status(400).json({ message: 'Date loaned is required for a loan sale.' });
    }
    if (!date_to_be_paid) {
      return res.status(400).json({ message: 'Date to be paid is required for a loan sale.' });
    }
    loanAmountToBePaid = parseFloat(amount_to_be_paid);
    if (isNaN(loanAmountToBePaid) || loanAmountToBePaid <= 0) {
      return res.status(400).json({ message: 'Amount to be paid must be a positive number.' });
    }
    loanAmountPaid = amount_paid != null && amount_paid !== '' ? parseFloat(amount_paid) : 0;
    if (isNaN(loanAmountPaid) || loanAmountPaid < 0) {
      return res.status(400).json({ message: 'Amount paid cannot be negative.' });
    }
    if (loanAmountPaid > loanAmountToBePaid) {
      return res.status(400).json({ message: 'Amount paid cannot exceed the amount to be paid.' });
    }
    if (new Date(date_to_be_paid) < new Date(date_loaned)) {
      return res.status(400).json({ message: 'Date to be paid cannot be before the date loaned.' });
    }
  }

  try {
    const [products] = await db.query('SELECT * FROM products WHERE id = ?', [product_id]);
    if (products.length === 0) {
      return res.status(404).json({ message: 'Product not found.' });
    }

    const product = products[0];

    if (parseFloat(product.stock_quantity) < qty) {
      return res.status(400).json({
        message: `Not enough stock. Only ${product.stock_quantity} unit(s) available.`,
      });
    }

    // Use staff-entered price if provided
    // Minimum allowed = 25% of admin price (to allow quarter unit pricing)
    const min_allowed_price = parseFloat(product.selling_price) * 0.25;
    let actual_selling_price = parseFloat(product.selling_price);

    if (sale_price) {
      const entered = parseFloat(sale_price);
      if (entered < min_allowed_price) {
        return res.status(400).json({
          message: `Price too low. Minimum allowed is ${min_allowed_price.toFixed(2)} (25% of admin price)`
        });
      }
      actual_selling_price = entered;
    }

    // Total revenue = (price per unit × quantity) - discount
    // This correctly handles fractions: 0.5 qty × 1000 = 500
    const discountAmount = discount ? parseFloat(parseFloat(discount).toFixed(2)) : 0;

    const subtotal = actual_selling_price * qty;
    const total_revenue = parseFloat(Math.max(0, subtotal - discountAmount).toFixed(2));
    const total_cost = parseFloat(product.cost_price) * qty;
    const profit = total_revenue - total_cost;

    // Determine settlement status for loan sales. Cash sales are always settled.
    let is_settled = 1;
    let loanStatus = null;
    if (isLoan) {
      const fullyPaid = loanAmountPaid >= loanAmountToBePaid;
      const meetsThreshold = loanAmountPaid >= loanAmountToBePaid * LOAN_SETTLEMENT_THRESHOLD;
      is_settled = (fullyPaid || meetsThreshold) ? 1 : 0;
      loanStatus = fullyPaid ? 'fully_paid' : (loanAmountPaid > 0 ? 'partially_paid' : 'pending');
    }

    const [result] = await db.query(
      `INSERT INTO sales (product_id, user_id, quantity_sold, cost_price, selling_price, total_revenue, total_cost, profit, payment_type, is_settled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [product_id, req.user.id, qty, product.cost_price, actual_selling_price, total_revenue, total_cost, profit, isLoan ? 'loan' : 'cash', is_settled]
    );

    if (isLoan) {
      await db.query(
        `INSERT INTO loans (sale_id, customer_name, date_loaned, amount_paid, amount_to_be_paid, date_to_be_paid, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [result.insertId, customer_name.trim(), date_loaned, loanAmountPaid, loanAmountToBePaid, date_to_be_paid, loanStatus]
      );
    }

    // Stock is reduced for both cash and loan sales — the goods have left the shop.
    const new_stock = parseFloat(product.stock_quantity) - qty;
    await db.query('UPDATE products SET stock_quantity = ? WHERE id = ?', [new_stock, product_id]);

    const isLowStock = new_stock <= parseFloat(product.min_stock_limit);

    res.status(201).json({
      message: isLoan ? 'Loan sale recorded successfully.' : 'Sale recorded successfully.',
      sale_id: result.insertId,
      product: product.name,
      quantity_sold: qty,
      total_revenue,
      profit,
      remaining_stock: new_stock,
      payment_type: isLoan ? 'loan' : 'cash',
      is_settled: !!is_settled,
      low_stock_alert: isLowStock,
      alert_message: isLowStock
        ? `⚠️ Restock Alert: "${product.name}" is running low — only ${new_stock} unit(s) remaining!`
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/sales
router.get('/', authenticate, async (req, res) => {
  try {
    const [sales] = await db.query(
      `SELECT s.id, COALESCE(p.name, 'Deleted Product') AS product, u.name AS sold_by, s.quantity_sold,
              s.selling_price, s.total_revenue, s.profit, s.payment_type, s.is_settled, s.sale_date
       FROM sales s
       LEFT JOIN products p ON s.product_id = p.id
       JOIN users u ON s.user_id = u.id
       ORDER BY s.sale_date DESC
       LIMIT 100`
    );
    res.json({ sales });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router;
