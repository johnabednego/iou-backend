// routes/expenseRoutes.js
const express = require('express');
const router = express.Router();
const {
  submitExpense, getExpense, updateExpense, rejectExpense,
  assignExpenseApprovers, decideExpenseApproval,
  reconcile, redeemIOU
} = require('../controllers/expenseController');
const { isAuthenticated } = require('../middleware/auth');
const { requireCashierOrAdmin } = require('../middleware/roles');

// Expense CRUD
router.post('/:id/expense', isAuthenticated, submitExpense);
router.get('/:id/expense', isAuthenticated, getExpense);
router.put('/:id/expense', isAuthenticated, updateExpense);

// Expense rejection (Req 11)
router.post('/:id/expense/reject', isAuthenticated, requireCashierOrAdmin, rejectExpense);

// Expense approval circle (Req 12)
router.post('/:id/expense/assign-approvers', isAuthenticated, requireCashierOrAdmin, assignExpenseApprovers);
router.put('/:id/expense/approve/:approvalId', isAuthenticated, decideExpenseApproval);

// Reconciliation & Redemption
router.post('/:id/reconcile', isAuthenticated, requireCashierOrAdmin, reconcile);
router.post('/:id/redeem', isAuthenticated, redeemIOU);

module.exports = router;
