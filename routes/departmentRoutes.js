// routes/departmentRoutes.js
const express = require('express');
const router = express.Router();
const { listDepartments, updateDepartment, getHodForDepartment, createDepartment, syncLdap } = require('../controllers/departmentController');
const { isAuthenticated } = require('../middleware/auth');
const { requireCashierOrAdmin } = require('../middleware/roles');

router.get('/', isAuthenticated, listDepartments);
router.post('/', isAuthenticated, createDepartment);
router.post('/sync-ldap', isAuthenticated, requireCashierOrAdmin, syncLdap);
router.get('/hod-for/:departmentName', isAuthenticated, getHodForDepartment);
router.put('/:id', isAuthenticated, requireCashierOrAdmin, updateDepartment);

module.exports = router;
