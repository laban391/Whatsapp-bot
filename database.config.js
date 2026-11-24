'use strict';

// MongoDB configuration. Prefer setting MONGODB_URI privately in Altare.
// Never commit a real database URI or password to GitHub.
require('dotenv').config();

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  MONGODB_URI: process.env.MONGODB_URI || '',
  MONGODB_DB: process.env.MONGODB_DB || 'moon_whatsapp',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || ''
};
