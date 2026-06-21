const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate, adminOnly } = require('../middleware/auth');

// Helper: get date range based on period
const getDateRange = (period) => {
  const now = new Date();
  let startDate;
  switch (period) {
    case 'weekly':    startDate = new Date(now); startDate.setDate(now.getDate() - 7); break;
    case 'monthly':   startDate = new Date(now); startDate.setMonth(now.getMonth() - 1); break;
    case 'daily':        startDate = new Date(now); startDate.setDate(now.getDate() - 1); break;
    case 'semiannually': startDate = new Date(now); startDate.setMonth(now.getMonth() - 6); break;
    case 'annually':  startDate = new Date(now); startDate.setFullYear(now.getFullYear() - 1); break;
    default:          startDate = new Date(now); startDate.setMonth(now.getMonth() - 1);
  }
  return startDate.toISOString().slice(0, 19).replace('T', ' ');
};

// GET /api/reports/dashboard — Quick dashboard stats (admin only)
router.get('/dashboard', authenticate, adminOnly, async (req, res) => {
  try {
    // Dashboard shows current month stats only (resets each month)
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01 00:00:00`;

    const [salesStats] = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN is_settled = 1 THEN total_revenue ELSE 0 END), 0) AS total_revenue,
         COALESCE(SUM(CASE WHEN is_settled = 1 THEN profit ELSE 0 END), 0) AS total_profit,
         ROUND((COALESCE(SUM(CASE WHEN is_settled = 1 THEN profit ELSE 0 END), 0) / NULLIF(COALESCE(SUM(CASE WHEN is_settled = 1 THEN total_revenue ELSE 0 END), 0), 0)) * 100, 2) AS profit_margin_percent,
         COUNT(*) AS total_sales
       FROM sales
       WHERE sale_date >= ?`,
      [monthStart]
    );

    const [lowStock] = await db.query(
      `SELECT COUNT(*) AS low_stock_count FROM products WHERE stock_quantity <= min_stock_limit`
    );

    const [totalProducts] = await db.query(`SELECT COUNT(*) AS total_products FROM products`);

    const [recentSales] = await db.query(
      `SELECT s.id, COALESCE(p.name, 'Deleted Product') AS product, u.name AS sold_by,
              s.quantity_sold, s.total_revenue, s.payment_type, s.is_settled, s.sale_date
       FROM sales s
       LEFT JOIN products p ON s.product_id = p.id
       JOIN users u ON s.user_id = u.id
       ORDER BY s.sale_date DESC LIMIT 5`
    );

    res.json({
      stats: {
        ...salesStats[0],
        low_stock_count: lowStock[0].low_stock_count,
        total_products: totalProducts[0].total_products,
      },
      recent_sales: recentSales,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/reports/sales?period=weekly|monthly|quarterly|annually
router.get('/sales', authenticate, adminOnly, async (req, res) => {
  const period = req.query.period || 'monthly';
  const startDate = getDateRange(period);

  try {
    let whereClause = 'WHERE sale_date >= ?';
    let params = [startDate];

    // Handle specific date
    if (period === 'date' && req.query.date) {
      const dateStr = req.query.date.split('T')[0]; // strip any time component
      whereClause = "WHERE DATE_FORMAT(sale_date, '%Y-%m-%d') = ?";
      params = [dateStr];
    }
    // Handle specific month
    else if (period === 'month' && req.query.year && req.query.month) {
      whereClause = 'WHERE YEAR(sale_date) = ? AND MONTH(sale_date) = ?';
      params = [req.query.year, req.query.month];
    }

    const [summary] = await db.query(
      `SELECT
         COUNT(*) AS total_transactions,
         COALESCE(SUM(quantity_sold), 0) AS total_units_sold,
         COALESCE(SUM(CASE WHEN is_settled = 1 THEN total_revenue ELSE 0 END), 0) AS total_revenue,
         COALESCE(SUM(CASE WHEN is_settled = 1 THEN total_cost ELSE 0 END), 0) AS total_cost,
         COALESCE(SUM(CASE WHEN is_settled = 1 THEN profit ELSE 0 END), 0) AS total_profit,
         ROUND((COALESCE(SUM(CASE WHEN is_settled = 1 THEN profit ELSE 0 END), 0) / NULLIF(COALESCE(SUM(CASE WHEN is_settled = 1 THEN total_revenue ELSE 0 END), 0), 0)) * 100, 2) AS profit_margin_percent,
         COALESCE(SUM(CASE WHEN payment_type = 'loan' AND is_settled = 0 THEN 1 ELSE 0 END), 0) AS pending_loans
       FROM sales ${whereClause}`,
      params
    );

    const [byProduct] = await db.query(
      `SELECT COALESCE(p.name, 'Deleted Product') AS product, SUM(s.quantity_sold) AS units_sold,
              SUM(CASE WHEN s.is_settled = 1 THEN s.total_revenue ELSE 0 END) AS revenue,
              SUM(CASE WHEN s.is_settled = 1 THEN s.profit ELSE 0 END) AS profit
       FROM sales s LEFT JOIN products p ON s.product_id = p.id
       ${whereClause}
       GROUP BY s.product_id, p.name ORDER BY revenue DESC`,
      params
    );

    res.json({ period, summary: summary[0], by_product: byProduct });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/reports/profit
router.get('/profit', authenticate, adminOnly, async (req, res) => {
  try {
    const [overall] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN is_settled = 1 THEN total_revenue ELSE 0 END), 0) AS total_revenue,
              COALESCE(SUM(CASE WHEN is_settled = 1 THEN total_cost ELSE 0 END), 0) AS total_cost,
              COALESCE(SUM(CASE WHEN is_settled = 1 THEN profit ELSE 0 END), 0) AS total_profit,
              ROUND((COALESCE(SUM(CASE WHEN is_settled = 1 THEN profit ELSE 0 END), 0) / NULLIF(COALESCE(SUM(CASE WHEN is_settled = 1 THEN total_revenue ELSE 0 END), 0), 0)) * 100, 2) AS profit_margin_percent
       FROM sales`
    );

    const [byProduct] = await db.query(
      `SELECT p.name AS product, p.cost_price, p.selling_price,
              ROUND(((p.selling_price - p.cost_price) / p.selling_price) * 100, 2) AS margin_percent,
              COALESCE(SUM(CASE WHEN s.is_settled = 1 THEN s.profit ELSE 0 END), 0) AS total_profit_earned
       FROM products p LEFT JOIN sales s ON p.id = s.product_id
       GROUP BY p.id, p.name, p.cost_price, p.selling_price ORDER BY margin_percent DESC`
    );

    res.json({ overall: overall[0], by_product: byProduct });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/reports/dates — list of dates with sales
router.get('/dates', authenticate, adminOnly, async (req, res) => {
  try {
    const [dates] = await db.query(
      `SELECT DATE_FORMAT(sale_date, '%Y-%m-%d') AS date, COUNT(*) AS total_sales
       FROM sales
       GROUP BY DATE_FORMAT(sale_date, '%Y-%m-%d')
       ORDER BY DATE_FORMAT(sale_date, '%Y-%m-%d') DESC
       LIMIT 90`
    );
    res.json({ dates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/reports/months — list of months with sales
router.get('/months', authenticate, adminOnly, async (req, res) => {
  try {
    const [months] = await db.query(
      `SELECT YEAR(sale_date) AS year, MONTH(sale_date) AS month,
              LPAD(MONTH(sale_date),2,'0') AS month_pad,
              COUNT(*) AS total_sales
       FROM sales GROUP BY YEAR(sale_date), MONTH(sale_date)
       ORDER BY year DESC, month DESC`
    );
    res.json({ months: months.map(m => ({ ...m, month: m.month_pad })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router;
