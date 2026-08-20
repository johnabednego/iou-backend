require('dotenv').config();
const { Client } = require('ldapts');

async function testLdap() {
  const url = process.env.LDAP_SERVER;
  const bindDn = process.env.LDAP_BIND_DN;
  const bindPass = process.env.LDAP_BIND_PASSWORD;

  const client = new Client({ url });

  try {
    console.log(`Connecting to ${url}...`);
    console.log(`Binding as ${bindDn}...`);
    await client.bind(bindDn, bindPass);
    console.log('Successfully bound with service account credentials.');
  } catch (err) {
    console.error('LDAP Bind Error:', err);
  } finally {
    try {
      await client.unbind();
    } catch(e) {}
    process.exit(0);
  }
}

testLdap();
