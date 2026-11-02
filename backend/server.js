const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/message', (req, res) => {
  res.json({ message: 'Hello from the Node.js backend!' });
});

app.listen(5000, () => {
  console.log('Backend server running on http://localhost:5000');
});