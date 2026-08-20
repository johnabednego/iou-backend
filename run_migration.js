const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const sequelize = require('./config/database');

async function runMigrations() {
  const transaction = await sequelize.transaction();
  try {
    // Helper to add column if not exists
    const addColIfMissing = async (tableName, colName, colDef) => {
      const [cols] = await sequelize.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = '${tableName}' AND COLUMN_NAME = '${colName}'
      `, { transaction });
      if (cols.length === 0) {
        console.log(`Adding ${colName} to ${tableName}...`);
        await sequelize.query(`ALTER TABLE ${tableName} ADD ${colName} ${colDef};`, { transaction });
      }
    };

    await addColIfMissing('iou_requests', 'ifs_voucher_number', 'NVARCHAR(64) NULL');
    await addColIfMissing('reconciliation_records', 'ifs_voucher_number', 'NVARCHAR(64) NULL');
    await addColIfMissing('reconciliation_records', 'confirmed_by_user', 'BIT NOT NULL DEFAULT 0');
    await addColIfMissing('reconciliation_records', 'user_confirmed_at', 'DATETIME2 NULL');
    await addColIfMissing('reconciliation_records', 'confirmed_by_cashier', 'BIT NOT NULL DEFAULT 0');
    await addColIfMissing('reconciliation_records', 'cashier_confirmed_at', 'DATETIME2 NULL');
    await addColIfMissing('users', 'is_approver', 'BIT NOT NULL DEFAULT 0');

    // Alter existing DATETIME columns to DATETIME2 to support ISO date strings in MSSQL
    try {
      await sequelize.query(`ALTER TABLE reconciliation_records ALTER COLUMN user_confirmed_at DATETIME2 NULL;`, { transaction });
      await sequelize.query(`ALTER TABLE reconciliation_records ALTER COLUMN cashier_confirmed_at DATETIME2 NULL;`, { transaction });
    } catch (e) {
      // Column might already be DATETIME2 or not exist yet
    }

    await transaction.commit();
    console.log('Database schema migration checked successfully.');
  } catch (err) {
    await transaction.rollback();
    console.error('Database schema migration failed:', err.message);
  }
}

if (require.main === module) {
  runMigrations().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { runMigrations };
