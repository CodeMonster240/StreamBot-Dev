const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Directs Puppeteer to store Chrome inside your project folder
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
