// services/azureBlobService.js
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions
} = require('@azure/storage-blob');
const { randomUUID } = require('crypto');

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING || null;
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || null;
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY || null;
const containerName = process.env.AZURE_STORAGE_CONTAINER || 'ious-attachments';
const blobBaseUrlFromEnv = process.env.AZURE_BLOB_URL || null;

// blobBaseUrl: canonical base URL (no trailing slash)
const blobBaseUrl = (blobBaseUrlFromEnv && blobBaseUrlFromEnv.split('?')[0]) || (accountName ? `https://${accountName}.blob.core.windows.net` : null);

// warn if nothing configured
if (!connectionString && !(accountName && accountKey) && !blobBaseUrlFromEnv) {
  console.warn('Azure Storage: no connection string, account key, or blob base URL provided. Uploads/sas will fail until configured.');
}

let blobServiceClient = null;
let sharedKeyCredential = null;

if (connectionString) {
  try {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    // do not set sharedKeyCredential here (we may not have accountKey)
  } catch (e) {
    console.warn('Invalid AZURE_STORAGE_CONNECTION_STRING; cannot create BlobServiceClient from connection string.', e.message || e);
  }
} else if (accountName && accountKey) {
  try {
    sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
    blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, sharedKeyCredential);
  } catch (e) {
    console.warn('Failed to create BlobServiceClient from accountName/accountKey:', e.message || e);
  }
}

/**
 * Ensure container exists; create if missing.
 */
async function ensureContainerExists() {
  if (!blobServiceClient) throw new Error('Azure BlobServiceClient not configured. Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY.');
  const containerClient = blobServiceClient.getContainerClient(containerName);
  try {
    // createIfNotExists works whether container exists or not
    await containerClient.createIfNotExists({ access: 'private' });
  } catch (err) {
    // older sdk may not support access option; try create() fallback
    try {
      const exists = await containerClient.exists();
      if (!exists) await containerClient.create();
    } catch (e) {
      throw new Error(`Failed to ensure container exists: ${e.message || e}`);
    }
  }
  return containerClient;
}

/**
 * Upload a buffer and return canonical blob name and url (no SAS)
 */
async function uploadBuffer(buffer, originalName, contentType) {
  if (!blobServiceClient) throw new Error('Azure BlobServiceClient not configured. Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY.');

  const containerClient = await ensureContainerExists();
  const ext = (originalName && originalName.includes('.')) ? originalName.substring(originalName.lastIndexOf('.')) : '';
  const blobName = `${randomUUID()}${ext}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const uploadOptions = {
    blobHTTPHeaders: { blobContentType: contentType || 'application/octet-stream' }
  };

  await blockBlobClient.uploadData(buffer, uploadOptions);

  // blockBlobClient.url will be canonical URL (may include SAS if using connection string with SAS)
  const url = blockBlobClient.url;
  return { blobName, url };
}

/**
 * Delete a blob by name
 */
async function deleteBlob(blobName) {
  if (!blobServiceClient) throw new Error('Azure BlobServiceClient not configured. Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY.');
  const containerClient = await ensureContainerExists();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  const exists = await blockBlobClient.exists();
  if (!exists) return false;
  await blockBlobClient.delete();
  return true;
}

/**
 * Generate a read-only SAS URL for a blob (requires account key)
 *
 * Note: If you are using only a connection string that includes a SAS token or a public container,
 * sharedKeyCredential will be null and this function will throw a clear error.
 */
function generateBlobSAS(blobName, expiresMinutes = 60) {
  if (!sharedKeyCredential) {
    throw new Error('SAS generation requires AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY to be set. Alternatively, store a file_path with an embedded SAS.');
  }

  const now = new Date();
  const expiry = new Date(now.valueOf() + expiresMinutes * 60 * 1000);

  const sasParams = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: now,
      expiresOn: expiry
    },
    sharedKeyCredential
  ).toString();

  if (!blobBaseUrl) {
    throw new Error('AZURE_BLOB_URL is not configured; cannot construct SAS URL. Set AZURE_BLOB_URL (e.g., https://<account>.blob.core.windows.net)');
  }

  const sasUrl = `${blobBaseUrl}/${containerName}/${blobName}?${sasParams}`;
  return sasUrl;
}

module.exports = {
  uploadBuffer,
  deleteBlob,
  generateBlobSAS,
  ensureContainerExists
};
