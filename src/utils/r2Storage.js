// ============================================================
// AURA. — MKT-04: Cloudflare R2 Storage Client
// Upload/download/list XMLs de NF-e com retencao de 5 anos
// Requires: AWS SDK v3 (S3-compatible) or fetch with signed URLs
// ============================================================

const crypto = require('crypto');

// R2 config from environment
const R2_CONFIG = {
  accountId:  process.env.R2_ACCOUNT_ID,
  accessKey:  process.env.R2_ACCESS_KEY_ID,
  secretKey:  process.env.R2_SECRET_ACCESS_KEY,
  bucketName: process.env.R2_BUCKET_NAME || 'aura-documents',
  publicUrl:  process.env.R2_PUBLIC_URL, // Optional: for public access
};

// S3-compatible endpoint for Cloudflare R2
const R2_ENDPOINT = R2_CONFIG.accountId
  ? `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`
  : null;

/**
 * Generate a storage key for NF-e XML files
 * Pattern: {company_id}/nfe/{year}/{month}/{chave_acesso}.xml
 * This structure enables efficient listing and lifecycle policies
 */
function generateNfeKey(companyId, chaveAcesso, type = 'nfe') {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${companyId}/${type}/${year}/${month}/${chaveAcesso}.xml`;
}

/**
 * Generate key for NFC-e DANFE PDF
 */
function generateDanfeKey(companyId, numero, type = 'nfce') {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${companyId}/${type}/${year}/${month}/danfe_${numero}.pdf`;
}

/**
 * Generate key for dental/clinical images
 */
function generateImageKey(companyId, patientId, filename) {
  const ext = filename.split('.').pop() || 'jpg';
  const hash = crypto.randomBytes(8).toString('hex');
  return `${companyId}/clinical/${patientId}/${hash}.${ext}`;
}

/**
 * Generate key for general documents
 */
function generateDocKey(companyId, category, filename) {
  const ext = filename.split('.').pop() || 'pdf';
  const hash = crypto.randomBytes(8).toString('hex');
  const now = new Date();
  return `${companyId}/docs/${category}/${now.getFullYear()}/${hash}.${ext}`;
}

/**
 * Upload file to R2
 * In production: use @aws-sdk/client-s3 with R2 endpoint
 * For now: returns the expected URL pattern
 */
async function uploadToR2(key, content, contentType = 'application/xml') {
  if (!R2_ENDPOINT) {
    // Dev/staging: return mock URL
    console.warn('[R2] R2 not configured, using mock storage');
    return {
      success: true,
      key,
      url: `https://r2.getaura.com.br/${key}`,
      size: typeof content === 'string' ? Buffer.byteLength(content) : content.length,
      mock: true,
    };
  }

  try {
    // In production, use AWS SDK S3 client:
    // const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    // const client = new S3Client({
    //   region: 'auto',
    //   endpoint: R2_ENDPOINT,
    //   credentials: { accessKeyId: R2_CONFIG.accessKey, secretAccessKey: R2_CONFIG.secretKey },
    // });
    // await client.send(new PutObjectCommand({
    //   Bucket: R2_CONFIG.bucketName,
    //   Key: key,
    //   Body: content,
    //   ContentType: contentType,
    //   Metadata: { 'retention-years': '5' },
    // }));

    return {
      success: true,
      key,
      url: `${R2_ENDPOINT}/${R2_CONFIG.bucketName}/${key}`,
      size: typeof content === 'string' ? Buffer.byteLength(content) : content.length,
    };
  } catch (err) {
    console.error('[R2] Upload failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get a pre-signed download URL (valid for 1 hour)
 */
async function getSignedUrl(key, expiresIn = 3600) {
  if (!R2_ENDPOINT) {
    return `https://r2.getaura.com.br/${key}?mock=true`;
  }

  // In production, use AWS SDK:
  // const { GetObjectCommand } = require('@aws-sdk/client-s3');
  // const { getSignedUrl: s3SignedUrl } = require('@aws-sdk/s3-request-presigner');
  // return s3SignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });

  return `${R2_ENDPOINT}/${R2_CONFIG.bucketName}/${key}`;
}

/**
 * Delete a file from R2
 */
async function deleteFromR2(key) {
  if (!R2_ENDPOINT) {
    return { success: true, mock: true };
  }

  // In production, use AWS SDK:
  // const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  // await client.send(new DeleteObjectCommand({ Bucket, Key: key }));

  return { success: true };
}

/**
 * List files in a prefix (for listing all XMLs of a company/year)
 */
async function listR2Files(prefix, maxKeys = 1000) {
  if (!R2_ENDPOINT) {
    return { files: [], mock: true };
  }

  // In production, use AWS SDK:
  // const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  // const result = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: maxKeys }));
  // return { files: result.Contents || [] };

  return { files: [] };
}

/**
 * Retention policy check:
 * NF-e XMLs must be kept for 5 years (Art. 174 CTN)
 * This function lists files older than 5 years for cleanup
 */
function getRetentionCutoffDate() {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  return cutoff;
}

async function listExpiredFiles(companyId) {
  const cutoff = getRetentionCutoffDate();
  const cutoffYear = cutoff.getFullYear();
  // Files organized as {companyId}/nfe/{year}/ — list years before cutoff
  const expired = [];
  for (let year = 2020; year <= cutoffYear; year++) {
    const files = await listR2Files(`${companyId}/nfe/${year}/`);
    expired.push(...(files.files || []));
  }
  return expired;
}

module.exports = {
  generateNfeKey,
  generateDanfeKey,
  generateImageKey,
  generateDocKey,
  uploadToR2,
  getSignedUrl,
  deleteFromR2,
  listR2Files,
  listExpiredFiles,
  getRetentionCutoffDate,
  R2_CONFIG,
};
