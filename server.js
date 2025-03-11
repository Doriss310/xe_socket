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

const getAllDriversByStatus = async () => {
  try {
    logToFile("Fetching all drivers by status...");

    const [rides] = await db.query(`
        SELECT DISTINCT 
          r.id AS ride_id,
          d.phone_number AS driver_phone, 
          u.phone_number AS passenger_phone, 
          r.driver_mobile_status, 
          r.user_mobile_status
        FROM rides r
        LEFT JOIN drivers_users d ON r.driver_id = d.id
        LEFT JOIN users u ON r.passenger_id = u.id
        WHERE r.driver_id IS NOT NULL
        AND CASE 
                WHEN r.driver_mobile_status = 1 AND r.user_mobile_status = 1 THEN 0 
                WHEN r.driver_mobile_status = 1 OR r.user_mobile_status = 1 THEN 1 
                WHEN r.driver_mobile_status IS NULL AND r.user_mobile_status IS NULL THEN 1 
                ELSE 0 
              END = 1;
    `);

    logToFile(`Total rides fetched: ${rides.length}`);

    const driversMobileStatus = new Set();
    const usersMobileStatus = new Set();
    const ridesToUpdate = new Set();
    const excludedPhones = new Set();

    rides.forEach(ride => {
      if (ride.driver_mobile_status === 1 || ride.user_mobile_status === 1) {
        ridesToUpdate.add(ride.ride_id);
        excludedPhones.add(ride.driver_phone);
        excludedPhones.add(ride.passenger_phone);
      }
    });

    rides.forEach(ride => {
      if (!excludedPhones.has(ride.driver_phone) && (ride.driver_mobile_status == 0 || ride.driver_mobile_status == null)) {
        driversMobileStatus.add(ride.driver_phone);
      }
      if (!excludedPhones.has(ride.passenger_phone) && (ride.user_mobile_status == 0 || ride.user_mobile_status == null)) {
        usersMobileStatus.add(ride.passenger_phone);
      }
    });

    const result = {
      usersMobileStatus: [...usersMobileStatus],
      driversMobileStatus: [...driversMobileStatus]
    };

    logToFile(`Processed driversMobileStatus: ${JSON.stringify(result.driversMobileStatus)}`);
    logToFile(`Processed usersMobileStatus: ${JSON.stringify(result.usersMobileStatus)}`);

    return result;
  } catch (error) {
    logToFile(`Error fetching drivers by status: ${error.message}`);
    return { usersMobileStatus: [], driversMobileStatus: [] };
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


  getAllDriversByStatus().then(data => {
    ws.send(JSON.stringify({ event: "initial_data", data }));
  });

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
    const updatedStatus = await getAllDriversByStatus();
    const requestedDrivers = await getDriversWithRequestedRides();

    const newData = {
      updatedStatus,
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
