const { Client } = require('ldapts');
const User = require('../models/User');
const Department = require('../models/Department');

/**
 * Extract the first OU value from an LDAP DN string.
 */
function extractDepartmentFromDn(dn) {
  if (!dn || typeof dn !== 'string') return null;

  const match = dn.match(/(?:^|,)\s*OU=([^,]+)/i);

  if (match && match[1]) {
    return match[1].trim();
  }

  return null;
}

/**
 * Fetch LDAP users in batches.
 * Uses LDAP paging manually instead of ldapts.searchPaginated()
 */
async function fetchAllLdapUsers(client, baseDn) {
  const allEntries = [];

  let cookie = Buffer.alloc(0);
  const pageSize = 250;

  do {
    const result = await client.search(baseDn, {
      scope: 'sub',
      filter: '(&(objectCategory=person)(objectClass=user))',
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
      paged: {
        pageSize,
        cookie
      }
    });

    if (result.searchEntries && result.searchEntries.length) {
      allEntries.push(...result.searchEntries);
    }

    cookie = result.controls?.find(
      control => control.type === '1.2.840.113556.1.4.319'
    )?.value?.cookie || Buffer.alloc(0);

    console.log(
      `LDAP Sync: Retrieved ${allEntries.length} users so far...`
    );

  } while (cookie.length > 0);

  return allEntries;
}


/**
 * Fetch users from LDAP and synchronize departments and HOD mapping.
 */
async function syncLdapDepartmentsAndHods() {
  console.log('LDAP department synchronization is disabled in favor of custom Department Management.');
  return;

  const ldapUrl = process.env.LDAP_SERVER;
  const ldapBaseDn = process.env.LDAP_BASE_DN;
  const ldapBindDn = process.env.LDAP_BIND_DN;
  const ldapBindPassword = process.env.LDAP_BIND_PASSWORD;

  const client = new Client({
    url: ldapUrl
  });


try {

  console.log(
    'LDAP Sync: Connecting to service account...'
  );

  await client.bind(
    ldapBindDn,
    ldapBindPassword
  );


  console.log(
    'LDAP Sync: Fetching LDAP users...'
  );


  const searchEntries = await fetchAllLdapUsers(
    client,
    ldapBaseDn
  );


  console.log(
    `LDAP Sync: Fetched ${searchEntries.length} users. Indexing and mapping managers...`
  );


  const entryByDn = {};

  for (const entry of searchEntries) {

    if (entry.dn) {
      entryByDn[
        entry.dn.toLowerCase()
      ] = entry;
    }

  }



  const deptManagers = {};


  for (const entry of searchEntries) {

    const department = (() => {

      if (
        Array.isArray(entry.department) &&
        entry.department.length
      ) {
        return String(entry.department[0]);
      }


      if (
        typeof entry.department === 'string' &&
        entry.department.length
      ) {
        return entry.department;
      }


      if (
        Array.isArray(entry.ou) &&
        entry.ou.length
      ) {
        return String(entry.ou[0]);
      }


      if (
        typeof entry.ou === 'string' &&
        entry.ou.length
      ) {
        return entry.ou;
      }


      return extractDepartmentFromDn(entry.dn);

    })();



    const managerDn = (() => {

      if (
        Array.isArray(entry.manager) &&
        entry.manager.length
      ) {
        return String(entry.manager[0]);
      }


      if (
        typeof entry.manager === 'string' &&
        entry.manager.length
      ) {
        return entry.manager;
      }


      return null;

    })();



    if (department && managerDn) {

      const deptName = department.trim();


      if (!deptManagers[deptName]) {
        deptManagers[deptName] = new Map();
      }


      const lowerDn = managerDn.toLowerCase();


      const count =
        deptManagers[deptName].get(lowerDn) || 0;


      deptManagers[deptName].set(
        lowerDn,
        count + 1
      );

    }

  }



  const departmentHods = {};


  for (const deptName of Object.keys(deptManagers)) {

    let maxReports = -1;
    let bestManagerDn = null;


    for (
      const [
        managerDn,
        reportCount
      ] of deptManagers[deptName]
    ) {

      if (reportCount > maxReports) {

        maxReports = reportCount;
        bestManagerDn = managerDn;

      }

    }


    departmentHods[deptName] = bestManagerDn;

  }



  // console.log(
  //   'LDAP Sync: Processing HODs...',
  //   Object.keys(departmentHods)
  // );



  for (
    const [
      deptName,
      managerDn
    ] of Object.entries(departmentHods)
  ) {


    if (!managerDn) continue;


    let managerLdapEntry =
      entryByDn[managerDn.toLowerCase()];



    if (!managerLdapEntry) {

      try {

        const {
          searchEntries: managerEntries
        } = await client.search(
          managerDn,
          {
            scope: 'base',
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
            ]
          }
        );


        if (
          managerEntries &&
          managerEntries.length
        ) {
          managerLdapEntry = managerEntries[0];
        }


      } catch (err) {

        console.warn(
          `LDAP Sync: Could not fetch manager ${managerDn}`,
          err.message
        );

      }

    }



    if (!managerLdapEntry) {

      console.warn(
        `LDAP Sync: Manager not found ${managerDn}`
      );

      continue;

    }



    const managerUser =
      await User.upsertFromLdap(
        managerLdapEntry
      );



    const deptCode =
      deptName
        .substring(0, 3)
        .toUpperCase();



    const [
      deptModel,
      created
    ] =
      await Department.findOrCreate({
        where: {
          name: deptName
        },
        defaults: {
          code: deptCode,
          hod_user_id: managerUser.id,
          is_active: true
        }
      });

    if (created) {
      try {
        const DepartmentHOD = require('../models/DepartmentHOD');
        await DepartmentHOD.findOrCreate({
          where: { department_id: deptModel.id, user_id: managerUser.id }
        });
      } catch (_) { }
    }

  }


  console.log(
    'LDAP Sync: Synchronization completed successfully.'
  );


} catch (err) {

  console.error(
    'LDAP Sync Error:',
    err
  );


} finally {

  try {
    await client.unbind();
  } catch (_) { }

}

}


module.exports = {
  syncLdapDepartmentsAndHods
};