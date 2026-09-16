// controllers/fundController.js
const FundBalance = require('../models/FundBalance');
const FundTransaction = require('../models/FundTransaction');
const Currency = require('../models/Currency');
const User = require('../models/User');
const sequelize = require('../config/database');
const auditService = require('../services/auditService');

/**
 * GET /api/funds
 * List all fund balances for ACTIVE currencies (cashier/admin/approver only)
 */
exports.listFundBalances = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin && actor.role !== 'cashier' && !actor.is_approver) {
        return res.status(403).json({ message: 'Insufficient permissions' });
      }

      // Get all active currency codes
      const activeCurrencies = await Currency.findAll({
        where: { is_active: true },
        attributes: ['code'],
        raw: true
      });
      const activeCodes = activeCurrencies.map(c => c.code);

      // Only return balances for active currencies
      const balances = await FundBalance.findAll({
        where: activeCodes.length > 0 ? { currency: activeCodes } : {},
        include: [{ model: User, as: 'updatedBy', attributes: ['id', 'display_name', 'username'] }],
        order: [['currency', 'ASC']]
      });

      return res.json({ data: balances });
    } catch (err) {
      console.error('listFundBalances error', err);
      return res.status(500).json({ message: 'Error fetching fund balances' });
    }
  }
];

/**
 * PUT /api/funds/:currency
 * Update fund balance (cashier/admin only)
 * Body: { action: 'set' | 'increase' | 'decrease', amount: number, notes?: string }
 */
exports.updateFundBalance = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') {
        await t.rollback();
        return res.status(403).json({ message: 'Only cashier or admin can update fund balances' });
      }

      const { currency } = req.params;
      const { action, amount, notes } = req.body;
      const upperCurrency = currency.toUpperCase().trim();

      if (!action || !['set', 'increase', 'decrease'].includes(action)) {
        await t.rollback();
        return res.status(400).json({ message: "action must be 'set', 'increase', or 'decrease'" });
      }
      if (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) < 0) {
        await t.rollback();
        return res.status(400).json({ message: 'amount must be a non-negative number' });
      }

      const numAmount = Number(amount);

      // Find or create fund balance
      let [balance, created] = await FundBalance.findOrCreate({
        where: { currency: upperCurrency },
        defaults: { available_amount: 0, last_updated_by: actor.id },
        transaction: t
      });

      const previousAmount = Number(balance.available_amount);
      let newAmount;
      let txType;

      switch (action) {
        case 'set':
          newAmount = numAmount;
          txType = 'MANUAL_SET';
          break;
        case 'increase':
          newAmount = previousAmount + numAmount;
          txType = 'MANUAL_CREDIT';
          break;
        case 'decrease':
          if (previousAmount < numAmount) {
            await t.rollback();
            return res.status(400).json({
              message: `Cannot decrease by ${numAmount}. Current balance is ${previousAmount} ${upperCurrency}.`
            });
          }
          newAmount = previousAmount - numAmount;
          txType = 'MANUAL_DEBIT';
          break;
      }

      await balance.update({
        available_amount: newAmount,
        last_updated_by: actor.id,
        notes: notes || null
      }, { transaction: t });

      // Create transaction record
      await FundTransaction.create({
        currency: upperCurrency,
        type: txType,
        amount: numAmount,
        balance_after: newAmount,
        performed_by: actor.id,
        notes: notes || `${action} ${numAmount} ${upperCurrency}`
      }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'UPDATE_FUND_BALANCE',
        entity: 'FundBalance',
        entityId: balance.id,
        details: { currency: upperCurrency, action, amount: numAmount, previousAmount, newAmount }
      }, { transaction: t });

      await t.commit();

      return res.json({
        message: `Fund balance updated for ${upperCurrency}`,
        balance: {
          currency: upperCurrency,
          previous_amount: previousAmount,
          new_amount: newAmount,
          action
        }
      });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('updateFundBalance error', err);
      return res.status(500).json({ message: 'Error updating fund balance' });
    }
  }
];

/**
 * GET /api/funds/check/:currency/:amount
 * Check if sufficient funds available (any authenticated user)
 * Returns { sufficient: boolean } — NEVER reveals actual balance amount
 */
exports.checkFunds = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const { currency, amount } = req.params;
      const upperCurrency = currency.toUpperCase().trim();
      const numAmount = Number(amount);

      if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ message: 'amount must be a positive number' });
      }

      const balance = await FundBalance.findOne({ where: { currency: upperCurrency } });
      const available = balance ? Number(balance.available_amount) : 0;

      return res.json({ sufficient: available >= numAmount });
    } catch (err) {
      console.error('checkFunds error', err);
      return res.status(500).json({ message: 'Error checking funds' });
    }
  }
];

/**
 * GET /api/funds/transactions
 * List fund transaction history (cashier/admin only)
 * Query: ?currency=, ?type=, ?limit=, ?offset=
 */
exports.listFundTransactions = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin && actor.role !== 'cashier') {
        return res.status(403).json({ message: 'Only cashier or admin can view fund transactions' });
      }

      const { currency, type, limit = 100, offset = 0 } = req.query;
      const where = {};
      if (currency) where.currency = currency.toUpperCase().trim();
      if (type) where.type = type;

      const { count, rows } = await FundTransaction.findAndCountAll({
        where,
        include: [{ model: User, as: 'performer', attributes: ['id', 'display_name', 'username'] }],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      return res.json({ data: rows, total: count });
    } catch (err) {
      console.error('listFundTransactions error', err);
      return res.status(500).json({ message: 'Error fetching fund transactions' });
    }
  }
];
