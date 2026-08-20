const express = require('express');
const { login, logout } = require('../controllers/authController');

const router = express.Router();


/**
 * @swagger
 * tags:
 *   name: Authentication
 *   description: User authentication
 */

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Authenticate a user with LDAP
 *     description: Validates the user's Windows account credentials and returns available user information.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *                 example: johndoe
 *               password:
 *                 type: string
 *                 example: Passw0rd!
 *     responses:
 *       200:
 *         description: Successful authentication
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', login);


/**
 * @swagger
 * /auth/logout:
 *   get:
 *     summary: Logout user
 *     description: Destroys the user session and logs out.
 *     responses:
 *       200:
 *         description: Successfully logged out
 */
router.get('/logout', logout);


module.exports = router;