const express = require('express');
const cors = require('cors');

require('dotenv').config();
const fileRoutes = require('./csvFile/routes');

const app = express();
app.use(express.json());

app.use(cors({
  origin: 'http://localhost:5173'
}));
app.use('/api', fileRoutes);

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});