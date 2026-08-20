const sequelize = require('./config/database');

async function check() {
  try {
    const [results] = await sequelize.query(`
      SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME IN ('iou_requests', 'users', 'disbursements', 'expense_submissions')
      AND COLUMN_NAME IN ('id', 'iou_id', 'requester_id', 'cashier_id', 'submitter_id')
    `);
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

check();
