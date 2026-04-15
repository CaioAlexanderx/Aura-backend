// ============================================================
// AURA. — Cloudflare R2 Storage Client (REAL uploads)
// Uses @aws-sdk/client-s3 (S3-compatible API)
// ============================================================

var crypto = require('crypto');

var R2_ACCOUNT_ID  = process.env.R2_ACCOUNT_ID;
var R2_ACCESS_KEY  = process.env.R2_ACCESS_KEY_ID;
var R2_SECRET_KEY  = process.env.R2_SECRET_ACCESS_KEY;
var R2_BUCKET      = process.env.R2_BUCKET_NAME || 'aura-storage';
var R2_PUBLIC_URL  = process.env.R2_PUBLIC_URL || 'https://r2.getaura.com.br';

var R2_ENDPOINT = R2_ACCOUNT_ID
  ? 'https://' + R2_ACCOUNT_ID + '.r2.cloudflarestorage.com'
  : null;

// Lazy-load S3 client (only when needed)
var _s3Client = null;
function getS3Client() {
  if (_s3Client) return _s3Client;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY || !R2_SECRET_KEY) return null;
  var S3Client = require('@aws-sdk/client-s3').S3Client;
  _s3Client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY,
      secretAccessKey: R2_SECRET_KEY,
    },
  });
  return _s3Client;
}

// Key generators
function generateNfeKey(companyId, chaveAcesso, type) {
  var now = new Date();
  var year = now.getFullYear();
  var month = String(now.getMonth() + 1).padStart(2, '0');
  return companyId + '/' + (type || 'nfe') + '/' + year + '/' + month + '/' + chaveAcesso + '.xml';
}

function generateDanfeKey(companyId, numero, type) {
  var now = new Date();
  var year = now.getFullYear();
  var month = String(now.getMonth() + 1).padStart(2, '0');
  return companyId + '/' + (type || 'nfce') + '/' + year + '/' + month + '/danfe_' + numero + '.pdf';
}

function generateImageKey(companyId, patientId, filename) {
  var ext = (filename || 'image.jpg').split('.').pop() || 'jpg';
  var hash = crypto.randomBytes(8).toString('hex');
  return companyId + '/clinical/' + patientId + '/' + hash + '.' + ext;
}

function generateDocKey(companyId, category, filename) {
  var ext = (filename || 'document.pdf').split('.').pop() || 'pdf';
  var hash = crypto.randomBytes(8).toString('hex');
  var now = new Date();
  return companyId + '/docs/' + category + '/' + now.getFullYear() + '/' + hash + '.' + ext;
}

// Upload file to R2
async function uploadToR2(key, content, contentType) {
  var client = getS3Client();
  if (!client) {
    console.warn('[R2] Not configured (missing R2_ACCOUNT_ID/KEY) — using mock');
    return {
      success: true,
      key: key,
      url: R2_PUBLIC_URL + '/' + key,
      size: typeof content === 'string' ? Buffer.byteLength(content) : content.length,
      mock: true,
    };
  }

  try {
    var PutObjectCommand = require('@aws-sdk/client-s3').PutObjectCommand;
    var body = typeof content === 'string' ? Buffer.from(content, 'base64') : content;

    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }));

    var url = R2_PUBLIC_URL + '/' + key;
    console.log('[R2] Uploaded:', key, '(' + body.length + ' bytes)');

    return {
      success: true,
      key: key,
      url: url,
      size: body.length,
    };
  } catch (err) {
    console.error('[R2] Upload failed:', err.message);
    return { success: false, error: err.message };
  }
}

// Get pre-signed download URL
async function getSignedUrl(key, expiresIn) {
  var client = getS3Client();
  if (!client) return R2_PUBLIC_URL + '/' + key;

  try {
    var GetObjectCommand = require('@aws-sdk/client-s3').GetObjectCommand;
    var getSignedUrlFn = require('@aws-sdk/s3-request-presigner').getSignedUrl;
    return await getSignedUrlFn(client, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: expiresIn || 3600 });
  } catch (err) {
    console.error('[R2] Signed URL failed:', err.message);
    return R2_PUBLIC_URL + '/' + key;
  }
}

// Delete file from R2
async function deleteFromR2(key) {
  var client = getS3Client();
  if (!client) return { success: true, mock: true };

  try {
    var DeleteObjectCommand = require('@aws-sdk/client-s3').DeleteObjectCommand;
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    console.log('[R2] Deleted:', key);
    return { success: true };
  } catch (err) {
    console.error('[R2] Delete failed:', err.message);
    return { success: false, error: err.message };
  }
}

// List files by prefix
async function listR2Files(prefix, maxKeys) {
  var client = getS3Client();
  if (!client) return { files: [], mock: true };

  try {
    var ListObjectsV2Command = require('@aws-sdk/client-s3').ListObjectsV2Command;
    var result = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      MaxKeys: maxKeys || 1000,
    }));
    return { files: result.Contents || [] };
  } catch (err) {
    console.error('[R2] List failed:', err.message);
    return { files: [], error: err.message };
  }
}

// Retention check
function getRetentionCutoffDate() {
  var cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  return cutoff;
}

async function listExpiredFiles(companyId) {
  var cutoff = getRetentionCutoffDate();
  var cutoffYear = cutoff.getFullYear();
  var expired = [];
  for (var year = 2020; year <= cutoffYear; year++) {
    var files = await listR2Files(companyId + '/nfe/' + year + '/');
    expired.push.apply(expired, files.files || []);
  }
  return expired;
}

module.exports = {
  generateNfeKey: generateNfeKey,
  generateDanfeKey: generateDanfeKey,
  generateImageKey: generateImageKey,
  generateDocKey: generateDocKey,
  uploadToR2: uploadToR2,
  getSignedUrl: getSignedUrl,
  deleteFromR2: deleteFromR2,
  listR2Files: listR2Files,
  listExpiredFiles: listExpiredFiles,
  getRetentionCutoffDate: getRetentionCutoffDate,
  R2_CONFIG: { accountId: R2_ACCOUNT_ID, accessKey: R2_ACCESS_KEY, secretKey: R2_SECRET_KEY, bucketName: R2_BUCKET, publicUrl: R2_PUBLIC_URL },
};
