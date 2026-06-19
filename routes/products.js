const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate, adminOnly } = require('../middleware/auth');

// GET /api/products — View all products (both roles)
router.get('/', authenticate, async (req, res) => {
  try {
    const [products] = await db.query(
      'SELECT id, name, stock_quantity, min_stock_limit, cost_price, selling_price, updated_at FROM products ORDER BY name ASC'
    );

    // Attach low stock flag and notification alerts
    const productsWithStatus = products.map((p) => ({
      ...p,
      status: p.stock_quantity <= p.min_stock_limit ? 'Low Stock' : 'Good',
      low_stock_alert: p.stock_quantity <= p.min_stock_limit,
    }));

    res.json({ products: productsWithStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/products/low-stock — Get all low stock products (admin only)
router.get('/low-stock', authenticate, adminOnly, async (req, res) => {
  try {
    const [products] = await db.query(
      'SELECT id, name, stock_quantity, min_stock_limit FROM products WHERE stock_quantity <= min_stock_limit ORDER BY stock_quantity ASC'
    );

    res.json({
      low_stock_count: products.length,
      products,
      message:
        products.length > 0
          ? `⚠️ ${products.length} product(s) need restocking!`
          : 'All products are sufficiently stocked.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/products — Add new product (admin only)
router.post('/', authenticate, adminOnly, async (req, res) => {
  const { name, stock_quantity, min_stock_limit, cost_price, selling_price } = req.body;

  if (!name || stock_quantity == null || !cost_price || !selling_price) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  if (selling_price <= cost_price) {
    return res.status(400).json({ message: 'Selling price must be greater than cost price.' });
  }

  try {
    const [result] = await db.query(
      'INSERT INTO products (name, stock_quantity, min_stock_limit, cost_price, selling_price) VALUES (?, ?, ?, ?, ?)',
      [name, stock_quantity, min_stock_limit || 5, cost_price, selling_price]
    );

    const isLowStock = stock_quantity <= (min_stock_limit || 5);

    res.status(201).json({
      message: 'Product added successfully.',
      product_id: result.insertId,
      low_stock_alert: isLowStock,
      alert_message: isLowStock ? `⚠️ Warning: "${name}" is already at or below the minimum stock limit!` : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// PUT /api/products/:id — Update product stock/details (admin only)
router.put('/:id', authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { name, stock_quantity, min_stock_limit, cost_price, selling_price } = req.body;

  try {
    const [existing] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Product not found.' });
    }

    const updated = {
      name: name ?? existing[0].name,
      stock_quantity: stock_quantity ?? existing[0].stock_quantity,
      min_stock_limit: min_stock_limit ?? existing[0].min_stock_limit,
      cost_price: cost_price ?? existing[0].cost_price,
      selling_price: selling_price ?? existing[0].selling_price,
    };

    await db.query(
      'UPDATE products SET name=?, stock_quantity=?, min_stock_limit=?, cost_price=?, selling_price=? WHERE id=?',
      [updated.name, updated.stock_quantity, updated.min_stock_limit, updated.cost_price, updated.selling_price, id]
    );

    const isLowStock = updated.stock_quantity <= updated.min_stock_limit;

    res.json({
      message: 'Product updated successfully.',
      low_stock_alert: isLowStock,
      alert_message: isLowStock
        ? `⚠️ Restock Alert: "${updated.name}" has only ${updated.stock_quantity} unit(s) left. Minimum is ${updated.min_stock_limit}.`
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// DELETE /api/products/:id — Delete a product (admin only)
// Sales history is preserved for financial accuracy
router.delete('/:id', authenticate, adminOnly, async (req, res) => {
  const { id } = req.params;

  try {
    const [existing] = await db.query('SELECT id FROM products WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Product not found.' });
    }

    // Preserve sales history: set product_id to NULL before deleting
    await db.query('UPDATE sales SET product_id = NULL WHERE product_id = ?', [id]);
    await db.query('DELETE FROM products WHERE id = ?', [id]);
    res.json({ message: 'Product deleted. Sales history preserved.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router;
