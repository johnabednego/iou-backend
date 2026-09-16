// controllers/currencyController.js
const Currency = require('../models/Currency');
const IOURequest = require('../models/IOURequest');
const FundBalance = require('../models/FundBalance');
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const auditService = require('../services/auditService');

/**
 * GET /api/currencies
 * List currencies. Active by default for normal users.
 * Admin/cashier/approver: see all (including inactive with transactions).
 * Normal users: see active + inactive currencies they have personally used.
 */
exports.listCurrencies = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const isPrivileged = actor.is_admin || actor.role === 'cashier' || actor.is_approver;
      const includeInactive = req.query.include_inactive === 'true';

      // Get all currencies from DB
      let currencies = await Currency.findAll({ order: [['code', 'ASC']] });

      if (isPrivileged && includeInactive) {
        // Privileged users: show active + inactive that have at least one IOU transaction
        const inactiveCodes = currencies.filter(c => !c.is_active).map(c => c.code);
        if (inactiveCodes.length > 0) {
          const usedInactive = await IOURequest.findAll({
            attributes: [[sequelize.fn('DISTINCT', sequelize.col('currency')), 'currency']],
            where: { currency: { [Op.in]: inactiveCodes } },
            raw: true
          });
          const usedCodes = new Set(usedInactive.map(r => r.currency));
          // Filter: keep active + inactive with transactions
          currencies = currencies.filter(c => c.is_active || usedCodes.has(c.code));
        }
      } else if (!isPrivileged) {
        // Normal users: active currencies + inactive currencies THEY have used
        const inactiveCodes = currencies.filter(c => !c.is_active).map(c => c.code);
        let userUsedCodes = new Set();
        if (inactiveCodes.length > 0) {
          const userUsed = await IOURequest.findAll({
            attributes: [[sequelize.fn('DISTINCT', sequelize.col('currency')), 'currency']],
            where: {
              requester_id: actor.id,
              currency: { [Op.in]: inactiveCodes }
            },
            raw: true
          });
          userUsedCodes = new Set(userUsed.map(r => r.currency));
        }
        currencies = currencies.filter(c => c.is_active || userUsedCodes.has(c.code));
      } else {
        // Privileged but not requesting inactive: show active only
        currencies = currencies.filter(c => c.is_active);
      }

      return res.json({ data: currencies });
    } catch (err) {
      console.error('listCurrencies error', err);
      return res.status(500).json({ message: 'Error fetching currencies' });
    }
  }
];

/**
 * POST /api/currencies
 * Add a new currency (cashier/admin only)
 */
exports.createCurrency = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin && actor.role !== 'cashier') {
        return res.status(403).json({ message: 'Only cashier or admin can manage currencies' });
      }

      const { code, name, symbol } = req.body;
      if (!code || !name) return res.status(400).json({ message: 'code and name are required' });

      const upperCode = code.toUpperCase().trim();

      // Check if currency already exists (might be soft-deleted)
      const existing = await Currency.findOne({ where: { code: upperCode } });
      if (existing) {
        if (!existing.is_active) {
          // Re-activate it
          await existing.update({ is_active: true, name, symbol: symbol || existing.symbol });
          // Ensure fund balance exists
          await FundBalance.findOrCreate({
            where: { currency: upperCode },
            defaults: { available_amount: 0 }
          });
          await auditService.log({
            actorId: actor.id,
            actorName: actor.display_name || actor.username,
            action: 'REACTIVATE_CURRENCY',
            entity: 'Currency',
            entityId: existing.id,
            details: { code: upperCode }
          });
          return res.json({ message: 'Currency reactivated', currency: existing });
        }
        return res.status(409).json({ message: `Currency ${upperCode} already exists` });
      }

      const currency = await Currency.create({
        code: upperCode,
        name,
        symbol: symbol || null,
        is_active: true
      });

      // Auto-create fund balance record starting at 0
      await FundBalance.findOrCreate({
        where: { currency: upperCode },
        defaults: { available_amount: 0 }
      });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CREATE_CURRENCY',
        entity: 'Currency',
        entityId: currency.id,
        details: { code: upperCode, name }
      });

      return res.status(201).json({ message: 'Currency created', currency });
    } catch (err) {
      console.error('createCurrency error', err);
      return res.status(500).json({ message: 'Error creating currency' });
    }
  }
];

/**
 * PUT /api/currencies/:id
 * Update currency name/symbol (cashier/admin only)
 */
exports.updateCurrency = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin && actor.role !== 'cashier') {
        return res.status(403).json({ message: 'Only cashier or admin can manage currencies' });
      }

      const { id } = req.params;
      const currency = await Currency.findByPk(id);
      if (!currency) return res.status(404).json({ message: 'Currency not found' });

      const { name, symbol } = req.body;
      if (name) currency.name = name;
      if (symbol !== undefined) currency.symbol = symbol;
      await currency.save();

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'UPDATE_CURRENCY',
        entity: 'Currency',
        entityId: currency.id,
        details: { code: currency.code, name, symbol }
      });

      return res.json({ message: 'Currency updated', currency });
    } catch (err) {
      console.error('updateCurrency error', err);
      return res.status(500).json({ message: 'Error updating currency' });
    }
  }
];

/**
 * DELETE /api/currencies/:id
 * Soft-delete: sets is_active=false (cashier/admin only)
 * If currency has no transactions, permanently delete it.
 */
exports.deleteCurrency = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin && actor.role !== 'cashier') {
        return res.status(403).json({ message: 'Only cashier or admin can manage currencies' });
      }

      const { id } = req.params;
      const currency = await Currency.findByPk(id);
      if (!currency) return res.status(404).json({ message: 'Currency not found' });

      // Block if fund balance is not zero
      const fundBalance = await FundBalance.findOne({ where: { currency: currency.code } });
      const currentAmount = fundBalance ? Number(fundBalance.available_amount) : 0;
      if (currentAmount !== 0) {
        return res.status(400).json({
          message: `Cannot deactivate ${currency.code}. The fund balance is ${currentAmount.toFixed(2)}. Please decrease the balance to 0.00 before deactivating this currency.`
        });
      }

      // Check if any IOUs exist with this currency
      const iouCount = await IOURequest.count({ where: { currency: currency.code } });

      if (iouCount === 0) {
        // No transactions — permanently delete currency and its fund balance
        await FundBalance.destroy({ where: { currency: currency.code } });
        await currency.destroy();
        await auditService.log({
          actorId: actor.id,
          actorName: actor.display_name || actor.username,
          action: 'DELETE_CURRENCY',
          entity: 'Currency',
          entityId: id,
          details: { code: currency.code, permanent: true }
        });
        return res.json({ message: `Currency ${currency.code} permanently deleted (no transactions found)` });
      }

      // Has transactions — soft delete
      await currency.update({ is_active: false });
      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'DEACTIVATE_CURRENCY',
        entity: 'Currency',
        entityId: currency.id,
        details: { code: currency.code, iouCount }
      });

      return res.json({ message: `Currency ${currency.code} deactivated. ${iouCount} existing IOU(s) are preserved.` });
    } catch (err) {
      console.error('deleteCurrency error', err);
      return res.status(500).json({ message: 'Error deleting currency' });
    }
  }
];
