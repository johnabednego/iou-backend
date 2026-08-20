// controllers/authController.js
require('dotenv').config();
const { Client } = require('ldapts');
const User = require('../models/User');

const ldapUrl = process.env.LDAP_SERVER;
const ldapBaseDn = process.env.LDAP_BASE_DN;
const ldapBindDn = process.env.LDAP_BIND_DN;
const ldapBindPassword = process.env.LDAP_BIND_PASSWORD;

exports.login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'username and password are required' });
  }

  const client = new Client({ url: ldapUrl });

  try {
    // Bind with service account
    await client.bind(ldapBindDn, ldapBindPassword);

    // Search for user DN
    const { searchEntries } = await client.search(ldapBaseDn, {
      scope: 'sub',
      filter: `(sAMAccountName=${username})`,
      attributes: [
        'description',
        'title',
        'department',
        'company',
        'name',
        'givenName',
        'displayName',
        'sAMAccountName',
        'userPrincipalName',
        'mail',
        'manager'
      ],
    });

    if (!searchEntries || searchEntries.length < 1) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const ldapEntry = searchEntries[0];
    const userDn = ldapEntry.dn;

    // Bind with user credentials to verify password
    await client.bind(userDn, password);

    // Authentication successful - upsert user into local DB
    const savedUser = await User.upsertFromLdap(ldapEntry);

    // Save minimal session info and LDAP raw entry (used by middleware)
    req.session.user = {
      id: savedUser.id,
      username: savedUser.username,
      display_name: savedUser.display_name,
      email: savedUser.email,
      department: savedUser.department,
      manager: savedUser.manager,
      ldap: ldapEntry
    };

    return res.status(200).json({ message: 'Authentication successful', user: savedUser });
  } catch (error) {
    console.error('LDAP login error:', error && error.name ? error.name : error);

    if (error && error.name === 'InvalidCredentialsError') {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    return res.status(500).json({ message: 'Something went wrong during authentication' });
  } finally {
    try {
      await client.unbind();
    } catch (e) {
      // ignore
    }
  }
};

exports.logout = (req, res) => {
  if (!req.session) return res.status(200).json({ message: 'No active session' });
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error', err);
      return res.status(500).json({ message: 'Failed to destroy session' });
    }
    return res.status(200).json({ message: 'Logged out successfully' });
  });
};
