const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST,
  dialect: 'mssql',
  logging: false,
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
    evict: 1000,
  },
  retry: {
    max: 3,
  },
  dialectOptions: {
    options: {
      requestTimeout: 30000,
      connectTimeout: 15000,
    }
  }
});

module.exports = sequelize;

