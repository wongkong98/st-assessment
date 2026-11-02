const express = require('express');
const cors = require('cors');

require('dotenv').config();
const fileRoutes = require('./csvFile/routes');

const app = express();
app.use(express.json());

// Only needed when the frontend is served from a different origin than the API.
// Comma-separated list, e.g. CORS_ORIGIN=https://app.example.com,https://admin.example.com
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) }));
}
app.use('/api', fileRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});