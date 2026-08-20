const sequelize = require('./config/database');

async function drop() {
  try {
    console.log('Dropping tables...');
    await sequelize.query(`
      IF OBJECT_ID('reconciliation_records', 'U') IS NOT NULL DROP TABLE reconciliation_records;
      IF OBJECT_ID('expense_submissions', 'U') IS NOT NULL DROP TABLE expense_submissions;
      IF OBJECT_ID('disbursements', 'U') IS NOT NULL DROP TABLE disbursements;
    `);
    console.log('Successfully dropped tables');
  } catch (err) {
    console.error('Error dropping tables:', err);
  } finally {
    process.exit(0);
  }
}

drop();
