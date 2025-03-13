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
const clients = new Map();

const connectToDatabase = async () => {
  try {
    db = await mysql.createConnection(dbConfig);
  } catch (error) {
    logToFile(`Lỗi kết nối database: ${error.message}`);
    process.exit(1);
  }
};

const getDriversWithRequestedRides = async () => {
  try {
    logToFile("Fetching drivers with requested rides...");

    const [drivers] = await db.query(`
          SELECT drll.ride_id, du.phone_number, du.id AS driver_id
              FROM drivers_users du
              JOIN driver_ride_location_logs drll 
                  ON du.id = drll.driver_id
              JOIN devices d 
                  ON du.device_id = d.id
              WHERE drll.ride_status = 'requested'
              AND d.name = drll.vehicle_type
              ORDER BY du.phone_number ASC, drll.ride_id DESC;
    `);

    const uniqueDriverPhoneNumbers = [
      ...new Set(drivers.map((driver) => driver.phone_number)),
    ];

    logToFile(
      `Unique drivers with requested rides: ${JSON.stringify(
        uniqueDriverPhoneNumbers
      )}`
    );

    return uniqueDriverPhoneNumbers;
  } catch (error) {
    logToFile(`Error fetching drivers with requested rides: ${error.message}`);
    return [];
  }
};

const server = require("http").createServer();
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  const clientId = Date.now();
  console.log("Client connected");
  logToFile(`Client kết nối mới (ID: ${clientId})`);

  clients.set(ws, {
    id: clientId,
    isAlive: true,
    lastActivity: Date.now(),
  });

  getDriversWithRequestedRides().then((phoneNumbers) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "requested_drivers", phoneNumbers }));
    }
  });

  ws.on("message", (message) => {
    try {
      const parsedMessage = JSON.parse(message);

      if (parsedMessage.type === "ping") {
        const client = clients.get(ws);
        if (client) {
          client.lastActivity = Date.now();
          client.isAlive = true;
        }

        ws.send(
          JSON.stringify({
            type: "pong",
            timestamp: Date.now(),
          })
        );

        logToFile(`Nhận được ping từ client ${clientId}, đã gửi pong`);
      } else {
        console.log("Nhận được tin nhắn:", parsedMessage);
      }
    } catch (error) {
      console.error("Lỗi khi xử lý tin nhắn:", error);
      logToFile(`Lỗi khi xử lý tin nhắn: ${error.message}`);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    logToFile(`Client ngắt kết nối (ID: ${clientId})`);
    clients.delete(ws);
  });

  ws.on("error", (error) => {
    console.error(`Lỗi trong kết nối client ${clientId}:`, error);
    logToFile(`Lỗi trong kết nối client ${clientId}: ${error.message}`);
    clients.delete(ws);
  });
});

let previousStatus = null;

const monitorDriverStatus = async () => {
  console.log("Real-time driver status monitoring started...");
  logToFile("Real-time driver status monitoring started...");

  setInterval(async () => {
    const requestedDrivers = await getDriversWithRequestedRides();

    const newData = {
      requestedDrivers,
    };

    if (JSON.stringify(newData) !== JSON.stringify(previousStatus)) {
      previousStatus = newData;
      console.log("Data changed, sending update:", newData);
      logToFile(`Data changed, sending update: ${JSON.stringify(newData)}`);

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(
            JSON.stringify({ event: "driver_status_updated", data: newData })
          );
        }
      });
    }
  }, 5000);
};

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const client = clients.get(ws);

    if (!client) return;
    if (!client.isAlive) {
      logToFile(`Client ${client.id} không phản hồi, đóng kết nối`);
      clients.delete(ws);
      return ws.terminate();
    }

    client.isAlive = false;

    const inactiveTime = Date.now() - client.lastActivity;
    if (inactiveTime > 30000) {
      try {
        ws.send(
          JSON.stringify({
            type: "ping",
            timestamp: Date.now(),
          })
        );
        logToFile(`Gửi ping đến client ${client.id}`);
      } catch (error) {
        logToFile(`Lỗi khi gửi ping đến client ${client.id}: ${error.message}`);
        clients.delete(ws);
        ws.terminate();
      }
    }
  });
}, 30000);

server.on("close", () => {
  clearInterval(pingInterval);
  logToFile("Server đóng, đã dọn dẹp các interval");
});

const PORT = process.env.PORT || 3003;
server.listen(PORT, async () => {
  await connectToDatabase();
  console.log(`WebSocket Server is running on ws://localhost:${PORT}`);
  logToFile(`WebSocket Server is running on ws://localhost:${PORT}`);
  monitorDriverStatus();
});