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

// ── SSO Login via Smart Workplace token ───────────────────────────────────
// Called when a user arrives from the Smart Workplace portal with a JWT
// in the URL. We validate the token server-side against SWP's API, then
// upsert the user locally and create a session — no password needed.
exports.ssoLogin = async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ message: 'SSO token is required' });
  }

  const swpApiUrl = process.env.SWP_API_URL;
  if (!swpApiUrl) {
    console.error('SWP_API_URL is not configured in .env');
    return res.status(500).json({ message: 'SSO is not configured on this server' });
  }

  try {
    // 1. Validate the token against Smart Workplace backend
    const axios = require('axios');
    const validateRes = await axios.post(`${swpApiUrl}/api/auth/validate-token`, { token }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    if (!validateRes.data || !validateRes.data.valid) {
      return res.status(401).json({ message: 'Invalid or expired SSO token' });
    }

    const swpUser = validateRes.data.user;
    if (!swpUser || !swpUser.username) {
      return res.status(401).json({ message: 'SSO token does not contain user information' });
    }

    console.log(`🔑 SSO login via Smart Workplace: ${swpUser.username}`);

    // 2. Build a synthetic LDAP-like entry from SWP token data so we can
    //    reuse the existing User.upsertFromLdap() logic
    const syntheticLdapEntry = {
      sAMAccountName: swpUser.username,
      name: swpUser.name || swpUser.username,
      displayName: swpUser.name || swpUser.username,
      givenName: swpUser.name ? swpUser.name.split(' ')[0] : swpUser.username,
      userPrincipalName: swpUser.email || null,
      mail: swpUser.email || null,
      department: swpUser.department || null,
      title: swpUser.title || null,
    };

    // 3. Upsert user into IOU's local database
    const savedUser = await User.upsertFromLdap(syntheticLdapEntry);

    // 4. Create a session — identical to what normal LDAP login does
    req.session.user = {
      id: savedUser.id,
      username: savedUser.username,
      display_name: savedUser.display_name,
      email: savedUser.email,
      department: savedUser.department,
      manager: savedUser.manager,
      ldap: syntheticLdapEntry
    };

    console.log(`   🎉 SSO login OK for ${swpUser.username}`);
    return res.status(200).json({ message: 'SSO authentication successful', user: savedUser });
  } catch (error) {
    // Distinguish between SWP API rejection vs network errors
    if (error.response) {
      console.error('SSO token validation rejected:', error.response.status, error.response.data);
      return res.status(401).json({ message: 'Invalid or expired SSO token' });
    }
    console.error('SSO login error:', error.message);
    return res.status(500).json({ message: 'Failed to validate SSO token. Please try logging in manually.' });
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
