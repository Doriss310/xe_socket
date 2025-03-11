const mysql = require("mysql2/promise");
const WebSocket = require("ws");
require("dotenv").config();
const fs = require("fs");

const logToFile = (message) => {
  const timestamp = new Date().toISOString();
  fs.appendFileSync("server.log", `[${timestamp}] ${message}\n`);
};

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

let db;

const connectToDatabase = async () => {
  try {
    db = await mysql.createConnection(dbConfig);
  } catch (error) {
    process.exit(1);
  }
};

const getDriversWithRequestedRides = async () => {
  try {
    logToFile("Fetching drivers with requested rides...");

    const [drivers] = await db.query(`
          SELECT drll.ride_id, du.phone_number
          FROM drivers_users du
          JOIN driver_ride_location_logs drll ON du.id = drll.driver_id
          WHERE drll.ride_status = 'requested'
          ORDER BY du.phone_number ASC, drll.ride_id DESC;
    `);

    const uniqueDriverPhoneNumbers = [...new Set(drivers.map(driver => driver.phone_number))];

    logToFile(`Unique drivers with requested rides: ${JSON.stringify(uniqueDriverPhoneNumbers)}`);

    return uniqueDriverPhoneNumbers;
  } catch (error) {
    logToFile(`Error fetching drivers with requested rides: ${error.message}`);
    return [];
  }
};

const server = require("http").createServer();
const wss = new WebSocket.Server({ server });
wss.on("connection", (ws) => {
  console.log("Client connected");

  getDriversWithRequestedRides().then(phoneNumbers => {
    ws.send(JSON.stringify({ event: "requested_drivers", phoneNumbers }));
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

let previousStatus = null;

const monitorDriverStatus = async () => {
  console.log("Real-time driver status monitoring started...");

  setInterval(async () => {
    const requestedDrivers = await getDriversWithRequestedRides();

    const newData = {
      requestedDrivers
    };

    if (JSON.stringify(newData) !== JSON.stringify(previousStatus)) {
      previousStatus = newData;
      console.log("Data changed, sending update:", newData);

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ event: "driver_status_updated", data: newData }));
        }
      });
    }
  }, 5000);
};

const PORT = process.env.PORT || 3003;
server.listen(PORT, async () => {
  await connectToDatabase();
  console.log(`WebSocket Server is running on ws://localhost:${PORT}`);
  monitorDriverStatus();
});
