// routes/userRoutes.js
const express = require('express');
const {
  me,
  getUsers,
  getUserById,
  createUser,
  updateUser,
  setRole,
  addUserByEmail,
  listApprovers,
  addApprover,
  removeApprover
} = require('../controllers/userController');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User management (LDAP-backed; created on login). Local roles & admin flag managed here.
 */

/**
 * @swagger
 * /users/me:
 *   get:
 *     summary: Get current logged-in user
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: Current user object
 *       401:
 *         description: Not authenticated
 */
router.get('/me', me);
router.get('/approvers', listApprovers);
router.post('/approvers', addApprover);
router.delete('/approvers/:id', removeApprover);

/**
 * @swagger
 * /users:
 *   get:
 *     summary: List users
 *     tags: [Users]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Max number of users to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: List of users
 */
router.get('/', getUsers);

/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get a user by id
 *     tags: [Users]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User data
 *       404:
 *         description: Not found
 */
router.get('/:id', getUserById);

/**
 * @swagger
 * /users:
 *   post:
 *     summary: Create a user (admin only)
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               display_name:
 *                 type: string
 *               role:
 *                 type: string
 *               is_admin:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Created
 *       403:
 *         description: Forbidden
 */
router.post('/', createUser);

/**
 * @swagger
 * /users/{id}:
 *   put:
 *     summary: Update a user (owner or admin). Only admins can change role or is_admin.
 *     tags: [Users]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               display_name:
 *                 type: string
 *               email:
 *                 type: string
 *               department_id:
 *                 type: string
 *               is_active:
 *                 type: boolean
 *               role:
 *                 type: string
 *               is_admin:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Updated
 *       403:
 *         description: Forbidden
 */
router.put('/:id', updateUser);

/**
 * @swagger
 * /users/{id}/role:
 *   put:
 *     summary: "Admin-only: set user role and admin flag"
 *     tags: [Users]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               role:
 *                 type: string
 *               is_admin:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Role updated
 *       403:
 *         description: Forbidden
 */
router.put('/:id/role', setRole);

/**
 * @swagger
 * /users/add-by-email:
 *   post:
 *     summary: "Admin-only: add user by LDAP email lookup"
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               role:
 *                 type: string
 *               is_admin:
 *                 type: boolean
 *               preview:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: User added
 *       404:
 *         description: Not found in LDAP
 *       403:
 *         description: Forbidden
 */
router.post('/add-by-email', addUserByEmail);

module.exports = router;
