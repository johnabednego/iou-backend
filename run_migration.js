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
    await addColIfMissing('departments', 'is_active', 'BIT NOT NULL DEFAULT 1');
    await addColIfMissing('departments', 'description', 'NVARCHAR(256) NULL');
    await addColIfMissing('departments', 'ldap_aliases', 'NVARCHAR(MAX) NULL');

    // Promote all existing HODs in department_hods or departments.hod_user_id to role = 'hod' (if not admin)
    try {
      await sequelize.query(`
        UPDATE users
        SET role = 'hod'
        WHERE role != 'admin'
          AND (
            id IN (SELECT user_id FROM department_hods)
            OR id IN (SELECT hod_user_id FROM departments WHERE hod_user_id IS NOT NULL)
          );
      `, { transaction });
      console.log('Promoted all department HOD users to role hod.');
    } catch (hodRoleErr) {
      console.warn('HOD role update note:', hodRoleErr.message);
    }

    // Create department_hods table if missing
    const [deptHodsTable] = await sequelize.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_NAME = 'department_hods'
    `, { transaction });

    if (deptHodsTable.length === 0) {
      console.log('Creating department_hods table...');
      await sequelize.query(`
        CREATE TABLE department_hods (
          id NVARCHAR(64) PRIMARY KEY,
          department_id NVARCHAR(64) NOT NULL,
          user_id NVARCHAR(64) NOT NULL,
          created_at DATETIME2 NULL,
          updated_at DATETIME2 NULL,
          CONSTRAINT UQ_department_hods UNIQUE (department_id, user_id)
        );
      `, { transaction });
    }

    // Seed department_hods from existing departments.hod_user_id
    try {
      await sequelize.query(`
        INSERT INTO department_hods (id, department_id, user_id, created_at, updated_at)
        SELECT LOWER(NEWID()), id, hod_user_id, GETDATE(), GETDATE()
        FROM departments
        WHERE hod_user_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM department_hods dh 
            WHERE dh.department_id = departments.id AND dh.user_id = departments.hod_user_id
          );
      `, { transaction });
    } catch (seedErr) {
      console.warn('Initial department_hods seeding note:', seedErr.message);
    }

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
