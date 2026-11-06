// routes/directExpenseRoutes.js
const express = require('express');
const router = express.Router();
const {
  createDirectExpense,
  listDirectExpenses,
  getDirectExpense,
  updateDirectExpense,
  submitDirectExpense,
  assignApprovers,
  confirmApproval,
  disburse,
  confirmDisbursement,
  getDisbursements,
  cashierRejectDE,
  cashierReturnDE
} = require('../controllers/directExpenseController');
const { isAuthenticated } = require('../middleware/auth');
const { requireCashierOrAdmin } = require('../middleware/roles');

// CRUD
router.post('/', isAuthenticated, createDirectExpense);
router.get('/', isAuthenticated, listDirectExpenses);
router.get('/:id', isAuthenticated, getDirectExpense);
router.put('/:id', isAuthenticated, updateDirectExpense);

// Workflow
router.post('/:id/submit', isAuthenticated, submitDirectExpense);
router.post('/:id/assign-approvers', isAuthenticated, requireCashierOrAdmin, assignApprovers);
router.post('/:id/confirm-approval', isAuthenticated, requireCashierOrAdmin, confirmApproval);

// Disbursement
router.post('/:id/disburse', isAuthenticated, requireCashierOrAdmin, disburse);
router.post('/:id/confirm-disbursement', isAuthenticated, confirmDisbursement);
router.get('/:id/disbursements', isAuthenticated, getDisbursements);

// Cashier reject/return
router.post('/:id/cashier-reject', isAuthenticated, requireCashierOrAdmin, cashierRejectDE);
router.post('/:id/cashier-return', isAuthenticated, requireCashierOrAdmin, cashierReturnDE);

module.exports = router;

