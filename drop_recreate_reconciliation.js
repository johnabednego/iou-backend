const sequelize = require('./config/database');

async function fix() {
  try {
    console.log('Dropping reconciliation_records...');
    await sequelize.query("IF OBJECT_ID('reconciliation_records', 'U') IS NOT NULL DROP TABLE reconciliation_records;");
    console.log('Recreating reconciliation_records with correct schema...');
    await sequelize.query(`
      CREATE TABLE reconciliation_records (
        id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        expense_id UNIQUEIDENTIFIER NOT NULL,
        iou_id UNIQUEIDENTIFIER NOT NULL,
        estimated_amount DECIMAL(18,2) NULL,
        actual_amount DECIMAL(18,2) NOT NULL,
        diff_amount DECIMAL(18,2) NOT NULL,
        action_required NVARCHAR(64) NOT NULL DEFAULT 'NONE',
        notes NVARCHAR(2000) NULL,
        created_by UNIQUEIDENTIFIER NOT NULL,
        created_at DATETIMEOFFSET NOT NULL DEFAULT GETDATE(),
        updated_at DATETIMEOFFSET NOT NULL DEFAULT GETDATE(),
        FOREIGN KEY (expense_id) REFERENCES expense_submissions (id),
        FOREIGN KEY (iou_id) REFERENCES iou_requests (id),
        FOREIGN KEY (created_by) REFERENCES users (id)
      );
    `);
    console.log('Done! reconciliation_records recreated successfully');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

fix();
