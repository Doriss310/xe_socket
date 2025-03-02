const mysql = require("mysql2/promise");
const WebSocket = require("ws");
require("dotenv").config();

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "test",
};

let db;


const connectToDatabase = async () => {
  try {
    db = await mysql.createConnection(dbConfig);
    console.log("Database connected successfully");
  } catch (error) {
    console.error("Error connecting to database:", error.message);
    process.exit(1);
  }
};


const getAllDriversByStatus = async () => {
  try {
    const [rides] = await db.query(`
      SELECT DISTINCT 
        d.phone_number AS driver_phone, 
        u.phone_number AS passenger_phone, 
        r.driver_mobile_status, 
        r.user_mobile_status
      FROM rides r
      LEFT JOIN drivers_users d ON r.driver_id = d.id
      LEFT JOIN users u ON r.passenger_id = u.id
      WHERE r.driver_id IS NOT NULL
    `);

    const driversMobileStatus = new Set();
    const usersMobileStatus = new Set();

    rides.forEach(ride => {
      if (ride.driver_mobile_status === 0) {
        driversMobileStatus.add(ride.driver_phone);
      }
      if (ride.user_mobile_status === 0) {
        usersMobileStatus.add(ride.passenger_phone);
      }
    });

    return {
      usersMobileStatus: [...usersMobileStatus],
      driversMobileStatus: [...driversMobileStatus]
    };
  } catch (error) {
    console.error("Unable to get drivers by status:", error.message);
    return { usersMobileStatus: [], driversMobileStatus: [] };
  }
};

const server = require("http").createServer();
const wss = new WebSocket.Server({ server });
wss.on("connection", (ws) => {
  console.log("Client connected");


  getAllDriversByStatus().then(data => {
    ws.send(JSON.stringify({ event: "initial_data", data }));
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

    if (JSON.stringify(updatedStatus) !== JSON.stringify(previousStatus)) {
      previousStatus = updatedStatus;
      console.log("Data changed, sending update:", updatedStatus);

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ event: "driver_status_updated", data: updatedStatus }));
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
