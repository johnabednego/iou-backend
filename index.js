require('dotenv').config();
const express = require('express');
const cors = require('cors')
const session = require('express-session');
const bodyParser = require('body-parser');

const models = require('./models'); // loads models and sets associations
const sequelize = models.sequelize;

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const iouRoutes = require('./routes/iouRoutes');
const approvalRoutes = require('./routes/approvalRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const disbursementRoutes = require('./routes/disbursementRoutes');
const expenseRoutes = require('./routes/expenseRoutes');
const auditRoutes = require('./routes/auditRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const exportRoutes = require('./routes/exportRoutes');
const currencyRoutes = require('./routes/currencyRoutes');
const fundRoutes = require('./routes/fundRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');

const setupSwaggerDocs = require('./config/swagger');


const app = express();
app.use(cors({
  origin: ['http://localhost:3002', 'http://172.20.24.134:3002', 'http://mpslocappsvr.mpsgh.com:3002'],
  credentials: true
}));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false } // secure:true in prod+https
}));


// Define routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
// Export route MUST be mounted before main IOU routes so /export is matched before /:id
app.use('/api/ious', exportRoutes);
app.use('/api/ious', iouRoutes);
app.use('/api/ious', disbursementRoutes);
app.use('/api/ious', expenseRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/currencies', currencyRoutes);
app.use('/api/funds', fundRoutes);
app.use('/api/analytics', analyticsRoutes);

// Setup Swagger Docs
setupSwaggerDocs(app);


// Sync database & run column migrations
sequelize.sync({ force: false })
  .then(async () => {
    console.log('Database synced successfully');

    try {
      const { runMigrations } = require('./run_migration');
      await runMigrations();
    } catch (err) {
      console.error('Migration check skipped:', err.message);
    }

    // One-time migration: rename role 'finance' → 'authorizer'
    try {
      const [results] = await sequelize.query(
        "UPDATE users SET role = 'authorizer' WHERE role = 'finance'"
      );
      if (results > 0) console.log(`Migrated ${results} user(s) from 'finance' to 'authorizer' role.`);
    } catch (err) {
      console.warn('Finance→Authorizer migration skipped:', err.message);
    }

    // Seed default currencies if none exist
    try {
      const Currency = require('./models/Currency');
      const FundBalance = require('./models/FundBalance');
      const count = await Currency.count();
      if (count === 0) {
        const defaults = [
          { code: 'GHS', name: 'Ghana Cedi', symbol: '₵' },
          { code: 'USD', name: 'US Dollar', symbol: '$' },
          { code: 'EUR', name: 'Euro', symbol: '€' },
          { code: 'GBP', name: 'British Pound', symbol: '£' }
        ];
        await Currency.bulkCreate(defaults);
        // Also create fund balance records (starting at 0)
        for (const cur of defaults) {
          await FundBalance.findOrCreate({
            where: { currency: cur.code },
            defaults: { available_amount: 0 }
          });
        }
        console.log('Seeded default currencies: GHS, USD, EUR, GBP');
      }
    } catch (err) {
      console.warn('Currency seeding skipped:', err.message);
    }

    // Start expense reminder cron job (checks every hour, sends reminders every 24h per IOU)
    try {
      const { checkAndSendExpenseReminders } = require('./services/reminderService');
      // Run once on startup (after a short delay)
      setTimeout(() => {
        checkAndSendExpenseReminders().catch(err => console.error('Initial reminder check error:', err));
      }, 10000);
      // Then run every hour
      setInterval(() => {
        checkAndSendExpenseReminders().catch(err => console.error('Reminder cron error:', err));
      }, 60 * 60 * 1000); // 1 hour
      console.log('[ReminderService] Expense reminder cron started (hourly checks).');
    } catch (err) {
      console.error('Failed to start reminder service:', err.message);
    }
  })
  .catch(err => console.error('Error syncing database:', err));

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
