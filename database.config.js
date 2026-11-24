'use strict';

// Altare deployment: configure these values in the service Environment settings.
// Never commit real credentials or tokens to GitHub.
require('dotenv').config();
module.exports = {
  PORT: Number(process.env.PORT || 3000),
  DB_HOST: process.env.DB_HOST || '',
  DB_PORT: Number(process.env.DB_PORT || 3306),
  DB_NAME: process.env.DB_NAME || '',
  DB_USER: process.env.DB_USER || '',
  DB_PASSWORD: process.env.DB_PASSWORD || '',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || ''
};
