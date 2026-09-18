// routes/departmentRoutes.js
const express = require('express');
const router = express.Router();
const {
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getHodForDepartment,
  mergeDepartments
} = require('../controllers/departmentController');
const { isAuthenticated, requireAdmin } = require('../middleware/auth');
const { requireCashierOrAdmin } = require('../middleware/roles');

router.get('/', isAuthenticated, listDepartments);
router.post('/', isAuthenticated, requireCashierOrAdmin, createDepartment);
router.post('/merge', isAuthenticated, requireCashierOrAdmin, mergeDepartments);
router.get('/hod-for/:departmentName', isAuthenticated, getHodForDepartment);
router.get('/:id', isAuthenticated, getDepartment);
router.put('/:id', isAuthenticated, requireCashierOrAdmin, updateDepartment);
router.delete('/:id', isAuthenticated, requireAdmin, deleteDepartment);

module.exports = router;
