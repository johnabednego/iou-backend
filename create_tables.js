const sequelize = require('./config/database');

async function create() {
  try {
    console.log('Creating tables...');
    await sequelize.query(`
      IF OBJECT_ID('disbursements', 'U') IS NULL 
      CREATE TABLE disbursements (
        id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        iou_id UNIQUEIDENTIFIER NOT NULL,
        cashier_id UNIQUEIDENTIFIER NOT NULL,
        amount DECIMAL(18,2) NOT NULL,
        payment_method NVARCHAR(64) NULL,
        payment_reference NVARCHAR(128) NULL,
        disbursed_at DATETIMEOFFSET NULL,
        notes NVARCHAR(1000) NULL,
        created_at DATETIMEOFFSET NOT NULL DEFAULT GETDATE(),
        updated_at DATETIMEOFFSET NOT NULL DEFAULT GETDATE(),
        FOREIGN KEY (iou_id) REFERENCES iou_requests (id),
        FOREIGN KEY (cashier_id) REFERENCES users (id)
      );
    `);

    await sequelize.query(`
      IF OBJECT_ID('expense_submissions', 'U') IS NULL 
      CREATE TABLE expense_submissions (
        id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        iou_id UNIQUEIDENTIFIER NOT NULL,
        submitter_id UNIQUEIDENTIFIER NOT NULL,
        actual_amount DECIMAL(18,2) NOT NULL,
        status NVARCHAR(32) NOT NULL DEFAULT 'SUBMITTED',
        submitted_at DATETIMEOFFSET NULL,
        deadline DATETIMEOFFSET NULL,
        notes NVARCHAR(1000) NULL,
        attachments NVARCHAR(MAX) NULL,
        created_at DATETIMEOFFSET NOT NULL DEFAULT GETDATE(),
        updated_at DATETIMEOFFSET NOT NULL DEFAULT GETDATE(),
        FOREIGN KEY (iou_id) REFERENCES iou_requests (id),
        FOREIGN KEY (submitter_id) REFERENCES users (id)
      );
    `);

    await sequelize.query(`
      IF OBJECT_ID('reconciliation_records', 'U') IS NULL 
      CREATE TABLE reconciliation_records (
        id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        expense_id UNIQUEIDENTIFIER NOT NULL,
        iou_id UNIQUEIDENTIFIER NOT NULL,
        estimated_amount DECIMAL(18,2) NOT NULL,
        disbursed_amount DECIMAL(18,2) NOT NULL,
        actual_amount DECIMAL(18,2) NOT NULL,
        difference DECIMAL(18,2) NOT NULL,
        action_required NVARCHAR(64) NULL,
        is_reconciled BIT NOT NULL DEFAULT 0,
        reconciled_at DATETIMEOFFSET NULL,
        notes NVARCHAR(1000) NULL,
        created_by UNIQUEIDENTIFIER NOT NULL,
        created_at DATETIMEOFFSET NOT NULL DEFAULT GETDATE(),
        updated_at DATETIMEOFFSET NOT NULL DEFAULT GETDATE(),
        FOREIGN KEY (expense_id) REFERENCES expense_submissions (id),
        FOREIGN KEY (iou_id) REFERENCES iou_requests (id),
        FOREIGN KEY (created_by) REFERENCES users (id)
      );
    `);
    console.log('Successfully created tables');
  } catch (err) {
    console.error('Error creating tables:', err);
  } finally {
    process.exit(0);
  }
}

create();
