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
    // and default any unassigned HOD back to 'employee'
    try {
      await sequelize.query(`
        UPDATE users
        SET role = 'hod'
        WHERE role != 'admin'
          AND (
            id IN (SELECT user_id FROM department_hods WHERE user_id IS NOT NULL)
            OR id IN (SELECT hod_user_id FROM departments WHERE hod_user_id IS NOT NULL AND is_active = 1)
          );
      `, { transaction });

      await sequelize.query(`
        UPDATE users
        SET role = 'employee'
        WHERE role = 'hod'
          AND id NOT IN (SELECT user_id FROM department_hods WHERE user_id IS NOT NULL)
          AND id NOT IN (SELECT hod_user_id FROM departments WHERE hod_user_id IS NOT NULL AND is_active = 1);
      `, { transaction });

      console.log('Synchronized HOD roles: valid department heads promoted, unassigned users defaulted to employee.');
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
    // Check data type before altering to avoid errors that doom the transaction
    const [reconUserCol] = await sequelize.query(`
      SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'reconciliation_records' AND COLUMN_NAME = 'user_confirmed_at'
    `, { transaction });
    if (reconUserCol.length > 0 && reconUserCol[0].DATA_TYPE !== 'datetime2') {
      await sequelize.query(`ALTER TABLE reconciliation_records ALTER COLUMN user_confirmed_at DATETIME2 NULL;`, { transaction });
    }
    const [reconCashierCol] = await sequelize.query(`
      SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'reconciliation_records' AND COLUMN_NAME = 'cashier_confirmed_at'
    `, { transaction });
    if (reconCashierCol.length > 0 && reconCashierCol[0].DATA_TYPE !== 'datetime2') {
      await sequelize.query(`ALTER TABLE reconciliation_records ALTER COLUMN cashier_confirmed_at DATETIME2 NULL;`, { transaction });
    }

    // ─── Direct Expense migrations ───
    // Make approvals.iou_id nullable (needed for Direct Expense approvals that have no IOU)
    // Must drop FK constraint first, alter column, then re-add FK
    const [appIouCol] = await sequelize.query(
      "SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'approvals' AND COLUMN_NAME = 'iou_id'",
      { transaction }
    );
    if (appIouCol.length > 0 && appIouCol[0].IS_NULLABLE === 'NO') {
      console.log('Making approvals.iou_id nullable...');
      // Find and drop FK constraint
      const [appFks] = await sequelize.query(
        "SELECT fk.name AS fk_name FROM sys.foreign_keys fk " +
        "JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id " +
        "WHERE fk.parent_object_id = OBJECT_ID('approvals') " +
        "AND COL_NAME(fkc.parent_object_id, fkc.parent_column_id) = 'iou_id'",
        { transaction }
      );
      for (const fk of appFks) {
        console.log(`  Dropping FK ${fk.fk_name}...`);
        await sequelize.query(`ALTER TABLE approvals DROP CONSTRAINT [${fk.fk_name}];`, { transaction });
      }
      // Get actual data type
      const [appColType] = await sequelize.query(
        "SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS " +
        "WHERE TABLE_NAME = 'approvals' AND COLUMN_NAME = 'iou_id'",
        { transaction }
      );
      const appDataType = appColType[0].DATA_TYPE === 'char'
        ? `CHAR(${appColType[0].CHARACTER_MAXIMUM_LENGTH})`
        : `NVARCHAR(${appColType[0].CHARACTER_MAXIMUM_LENGTH})`;
      await sequelize.query(`ALTER TABLE approvals ALTER COLUMN iou_id ${appDataType} NULL;`, { transaction });
      // Re-add FK
      await sequelize.query(
        `ALTER TABLE approvals ADD CONSTRAINT FK_approvals_iou_id FOREIGN KEY (iou_id) REFERENCES iou_requests(id);`,
        { transaction }
      );
      console.log('  approvals.iou_id is now nullable with FK restored.');
    }
    await addColIfMissing('approvals', 'direct_expense_id', 'NVARCHAR(64) NULL');

    // Make disbursements.iou_id nullable (needed for Direct Expense disbursements)
    const [disbIouCol] = await sequelize.query(
      "SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'disbursements' AND COLUMN_NAME = 'iou_id'",
      { transaction }
    );
    if (disbIouCol.length > 0 && disbIouCol[0].IS_NULLABLE === 'NO') {
      console.log('Making disbursements.iou_id nullable...');
      // Find and drop FK constraint
      const [disbFks] = await sequelize.query(
        "SELECT fk.name AS fk_name FROM sys.foreign_keys fk " +
        "JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id " +
        "WHERE fk.parent_object_id = OBJECT_ID('disbursements') " +
        "AND COL_NAME(fkc.parent_object_id, fkc.parent_column_id) = 'iou_id'",
        { transaction }
      );
      for (const fk of disbFks) {
        console.log(`  Dropping FK ${fk.fk_name}...`);
        await sequelize.query(`ALTER TABLE disbursements DROP CONSTRAINT [${fk.fk_name}];`, { transaction });
      }
      // Get actual data type
      const [disbColType] = await sequelize.query(
        "SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS " +
        "WHERE TABLE_NAME = 'disbursements' AND COLUMN_NAME = 'iou_id'",
        { transaction }
      );
      const disbDataType = disbColType[0].DATA_TYPE === 'char'
        ? `CHAR(${disbColType[0].CHARACTER_MAXIMUM_LENGTH})`
        : `NVARCHAR(${disbColType[0].CHARACTER_MAXIMUM_LENGTH})`;
      await sequelize.query(`ALTER TABLE disbursements ALTER COLUMN iou_id ${disbDataType} NULL;`, { transaction });
      // Re-add FK
      await sequelize.query(
        `ALTER TABLE disbursements ADD CONSTRAINT FK_disbursements_iou_id FOREIGN KEY (iou_id) REFERENCES iou_requests(id);`,
        { transaction }
      );
      console.log('  disbursements.iou_id is now nullable with FK restored.');
    }
    await addColIfMissing('disbursements', 'direct_expense_id', 'NVARCHAR(64) NULL');

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
