const express = require('express');
const cors = require('cors');

require('dotenv').config();
const fileRoutes = require('./csvFile/routes');
const socket = require('./utils/socket');

const app = express();
app.use(express.json());

if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) }));
}
app.use('/api', fileRoutes);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
socket.attach(server);