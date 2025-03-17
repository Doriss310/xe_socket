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

    // Lấy danh sách các chuyến đi đang ở trạng thái "requested"
    const [requestedRides] = await db.query(`
        SELECT DISTINCT drll.ride_id, drll.vehicle_type, drll.pickup_location 
        FROM driver_ride_location_logs drll
        WHERE drll.ride_status = 'requested'
    `);

    // Lấy danh sách tài xế đã có trong driver_ride_location_logs
    const [existingDrivers] = await db.query(`
        SELECT DISTINCT drll.ride_id, du.id AS driver_id, du.phone_number
        FROM drivers_users du
        JOIN driver_ride_location_logs drll ON du.id = drll.driver_id
        JOIN devices d ON du.device_id = d.id
        WHERE drll.ride_status = 'requested' AND d.name = drll.vehicle_type
    `);

    // Lấy danh sách tài xế active mà chưa có trong driver_ride_location_logs
    const [newDrivers] = await db.query(`
        SELECT DISTINCT ad.id AS driver_id, ad.phone_number, ad.device_id, ad.latitude, ad.longitude, ad.status, d.name AS vehicle_type
        FROM drivers_users ad
        JOIN devices d ON ad.device_id = d.id
        WHERE ad.status = 'active'
    `);

    let insertedDrivers = [];

    for (let ride of requestedRides) {
      // Truy vấn toàn bộ dữ liệu của chuyến đi để dùng cho INSERT
      const [rideDetails] = await db.query(
        `SELECT * FROM driver_ride_location_logs WHERE ride_id = ? LIMIT 1`, 
        [ride.ride_id]
      );

      if (rideDetails.length === 0) continue; // Nếu không có dữ liệu thì bỏ qua

      const rideData = rideDetails[0]; // Dữ liệu gốc của chuyến đi

      for (let driver of newDrivers) {
        // Kiểm tra nếu driver chưa có trong danh sách tài xế đã nhận ride_id này
        const alreadyExists = existingDrivers.some(
          (ex) => ex.ride_id === ride.ride_id && ex.driver_id === driver.driver_id
        );

        if (!alreadyExists && driver.vehicle_type === ride.vehicle_type) {
          // Tính khoảng cách giữa tài xế và điểm đón khách
          const pickupLat = parseFloat(ride.pickup_location.split(",")[0]);
          const pickupLon = parseFloat(ride.pickup_location.split(",")[1]);
          const driverLat = parseFloat(driver.latitude);
          const driverLon = parseFloat(driver.longitude);

          const distanceKm = await calculateDistance(pickupLat, pickupLon, driverLat, driverLon);
          const isAround10Km = distanceKm <= 10 ? 1 : 0;

          logToFile(`Adding new active driver ${driver.driver_id} to ride_id ${ride.ride_id}, distance: ${distanceKm.toFixed(2)} km`);

          // Chèn vào bảng driver_ride_location_logs với đầy đủ thông tin từ rideData, nhưng cập nhật is_around_10km
          await db.query(
            `INSERT INTO driver_ride_location_logs 
            (ride_id, passenger_id, driver_id, is_around_10km, pickup_location, pickup_address, 
             dropoff_location, dropoff_address, route_geometry, ride_status, accepted_at, started_at, 
             completed_at, arrived_at_pickup_time, distance_km, estimated_fare, estimated_time, 
             discount_amount, final_fare, actual_fare, waiting_fee, peak_hour_fee, duration_minutes, 
             vehicle_type, voucher_id, rating, feedback, assigned_at, cancelable, driver_mobile_status, 
             user_mobile_status, vat_percent, vat, location_id, latitude, longitude, device_id, 
             created_at, updated_at, is_delete)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
            [
              rideData.ride_id,
              rideData.passenger_id,
              driver.driver_id,
              isAround10Km,
              rideData.pickup_location,
              rideData.pickup_address,
              rideData.dropoff_location,
              rideData.dropoff_address,
              rideData.route_geometry,
              rideData.ride_status,
              rideData.accepted_at,
              rideData.started_at,
              rideData.completed_at,
              rideData.arrived_at_pickup_time,
              rideData.distance_km,
              rideData.estimated_fare,
              rideData.estimated_time,
              rideData.discount_amount,
              rideData.final_fare,
              rideData.actual_fare,
              rideData.waiting_fee,
              rideData.peak_hour_fee,
              rideData.duration_minutes,
              rideData.vehicle_type,
              rideData.voucher_id,
              rideData.rating,
              rideData.feedback,
              rideData.assigned_at,
              rideData.cancelable,
              rideData.driver_mobile_status,
              rideData.user_mobile_status,
              rideData.vat_percent,
              rideData.vat,
              rideData.location_id,
              driver.latitude,
              driver.longitude,
              driver.device_id,
              0
            ]
          );

          insertedDrivers.push({
            ride_id: ride.ride_id,
            driver_id: driver.driver_id,
            phone_number: driver.phone_number,
            distance_km: distanceKm.toFixed(2),
          });
        }
      }
    }

    const uniqueDriverPhoneNumbers = [
      ...new Set(existingDrivers.map((driver) => driver.phone_number).concat(insertedDrivers.map((driver) => driver.phone_number))),
    ];

    logToFile(`Unique drivers with requested rides (after insertion): ${JSON.stringify(uniqueDriverPhoneNumbers)}`);

    return uniqueDriverPhoneNumbers;
  } catch (error) {
    logToFile(`Error fetching drivers with requested rides: ${error.message}`);
    return [];
  }
};

// Hàm tính khoảng cách giữa hai tọa độ dựa trên công thức Haversine
const calculateDistance = async (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Bán kính Trái Đất (km)
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
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