const app = require('./app');
const socket = require('./utils/socket');

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
socket.attach(server);
