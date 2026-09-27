ALTER TABLE products
  ADD COLUMN unit_type ENUM('kg', 'piece', 'bag') NOT NULL DEFAULT 'piece' AFTER name;
