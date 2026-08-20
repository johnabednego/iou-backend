// middleware/uploadMulter.js
const multer = require('multer');
const bytes = require('bytes');

const maxMb = parseInt(process.env.MAX_UPLOAD_MB || '10', 10);
const maxBytes = maxMb * 1024 * 1024;
const allowedList = (process.env.ALLOWED_MIME_TYPES || 'image/jpeg,image/png,application/pdf').split(',');

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (allowedList.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type'), false);
  }
}

const upload = multer({
  storage,
  limits: { fileSize: maxBytes },
  fileFilter
});

module.exports = upload;
